// Áp một movement lên một balance — hàm THUẦN, không đụng DB.
// Quy tắc (định nghĩa tại đây, test ở tests/ledger.test.ts):
//   * qty luôn > 0; hướng cộng/trừ suy từ type (xem types.ts).
//   * Sau khi áp: mọi xô >= 0 và available >= 0. Vi phạm -> throw, KHÔNG trả balance méo.
//   * PICK tiêu thụ allocated trước: allocated giảm min(allocated, qty), phần còn lại
//     lấy thẳng từ available (pick lẻ không qua allocation vẫn hợp lệ).
//   * WRITE_OFF trừ xô damaged trước, phần còn lại trừ vào phần available của on_hand.
//   * MOVE không đổi số ở tầng 1 balance (chuyển vị trí được ledger ghi ở 2 balance:
//     xem rebuildBalances / recordMovement — ở đó MOVE = on_hand- tại nguồn, on_hand+ tại đích).
//   * REVERSAL không áp trực tiếp ở đây: dùng applyReversal(balance, movementGoc).
import {
  availableOf, roundQty, REASON_REQUIRED,
  type StockBalance, type StockBuckets, type StockMovement,
} from './types.ts'
import { REASON_CODES } from './reasons.ts'

const EPS = 1e-9

export function validateMovement(m: StockMovement): void {
  if (!m.sku?.trim()) throw new Error('Movement thiếu SKU')
  if (!Number.isFinite(m.qty) || m.qty <= 0) throw new Error(`Movement ${m.type}: số lượng phải lớn hơn 0`)
  if (REASON_REQUIRED.has(m.type)) {
    if (!m.reason_code?.trim()) throw new Error(`Movement ${m.type} bắt buộc có lý do (reason_code)`)
    if (!REASON_CODES.has(m.reason_code)) throw new Error(`Lý do không có trong danh mục: ${m.reason_code}`)
  }
  if (m.type === 'REVERSAL' && m.reverses_movement_id == null) {
    throw new Error('Movement REVERSAL bắt buộc có reverses_movement_id')
  }
}

/** Delta theo từng xô của một movement (chưa gồm MOVE hai phía và REVERSAL). */
export function deltaFor(m: StockMovement): Partial<StockBuckets> {
  const q = m.qty
  switch (m.type) {
    case 'RECEIVE':
    case 'RETURN_IN':
    case 'ADJUST_IN':
      return { on_hand: q }
    case 'PUTAWAY':
      return { inspect: -q }
    case 'ALLOCATE':
      return { allocated: q }
    case 'DEALLOCATE':
      return { allocated: -q }
    case 'ADJUST_OUT':
      return { on_hand: -q }
    case 'FREEZE':
      return { hold: q }
    case 'UNFREEZE':
      return { hold: -q }
    case 'DAMAGE':
      return { damaged: q }
    case 'TRANSFER_OUT':
      return { on_hand: -q, in_transit: q }
    case 'TRANSFER_IN':
      return { in_transit: -q, on_hand: q }
    case 'MOVE':
      return {}
    case 'PICK':
    case 'WRITE_OFF':
    case 'REVERSAL':
      // Xử lý riêng trong applyMovementToBalance (phụ thuộc số dư hiện tại).
      throw new Error(`deltaFor không áp cho ${m.type}; dùng applyMovementToBalance`)
  }
}

function assertNonNegative(b: StockBuckets, type: string): void {
  for (const k of ['on_hand', 'allocated', 'hold', 'damaged', 'inspect', 'in_transit'] as const) {
    if (b[k] < -EPS) throw new Error(`Movement ${type} làm xô ${k} âm (${b[k]})`)
  }
  if (availableOf(b) < -EPS) throw new Error(`Movement ${type} làm tồn khả dụng âm (${availableOf(b)})`)
}

function finish(base: StockBalance, next: StockBuckets): StockBalance {
  const b: StockBuckets = {
    on_hand: roundQty(next.on_hand), allocated: roundQty(next.allocated), hold: roundQty(next.hold),
    damaged: roundQty(next.damaged), inspect: roundQty(next.inspect), in_transit: roundQty(next.in_transit),
  }
  assertNonNegative(b, 'áp movement')
  return { ...base, ...b, available: availableOf(b) }
}

/** Áp một delta xô thô lên balance (có kiểm tra không âm) — dùng cho MOVE hai phía. */
export function applyBucketDelta(balance: StockBalance, delta: Partial<StockBuckets>, label = 'delta'): StockBalance {
  const next: StockBuckets = {
    on_hand: balance.on_hand + (delta.on_hand ?? 0),
    allocated: balance.allocated + (delta.allocated ?? 0),
    hold: balance.hold + (delta.hold ?? 0),
    damaged: balance.damaged + (delta.damaged ?? 0),
    inspect: balance.inspect + (delta.inspect ?? 0),
    in_transit: balance.in_transit + (delta.in_transit ?? 0),
  }
  try {
    return finish(balance, next)
  } catch {
    throw new Error(`Movement ${label} làm tồn âm hoặc vượt khả dụng`)
  }
}

/** Áp movement lên balance, trả balance MỚI (không sửa balance đầu vào). */
export function applyMovementToBalance(balance: StockBalance, m: StockMovement): StockBalance {
  validateMovement(m)
  const cur: StockBuckets = {
    on_hand: balance.on_hand, allocated: balance.allocated, hold: balance.hold,
    damaged: balance.damaged, inspect: balance.inspect, in_transit: balance.in_transit,
  }
  if (m.type === 'PICK') {
    if (cur.on_hand + EPS < m.qty) throw new Error(`PICK vượt tồn vật lý (on_hand=${cur.on_hand}, cần ${m.qty})`)
    const fromAlloc = Math.min(cur.allocated, m.qty)
    return finish(balance, { ...cur, on_hand: cur.on_hand - m.qty, allocated: cur.allocated - fromAlloc })
  }
  if (m.type === 'WRITE_OFF') {
    if (cur.on_hand + EPS < m.qty) throw new Error(`WRITE_OFF vượt tồn vật lý (on_hand=${cur.on_hand}, cần ${m.qty})`)
    const fromDamaged = Math.min(cur.damaged, m.qty)
    return finish(balance, { ...cur, on_hand: cur.on_hand - m.qty, damaged: cur.damaged - fromDamaged })
  }
  if (m.type === 'REVERSAL') {
    throw new Error('REVERSAL phải áp bằng applyReversal(balance, movement gốc)')
  }
  const d = deltaFor(m)
  const next: StockBuckets = {
    on_hand: cur.on_hand + (d.on_hand ?? 0),
    allocated: cur.allocated + (d.allocated ?? 0),
    hold: cur.hold + (d.hold ?? 0),
    damaged: cur.damaged + (d.damaged ?? 0),
    inspect: cur.inspect + (d.inspect ?? 0),
    in_transit: cur.in_transit + (d.in_transit ?? 0),
  }
  return finish(balance, next)
}

/**
 * Đảo ngược effect của movement gốc trên balance (dùng khi ghi REVERSAL).
 * Lưu ý: PICK/WRITE_OFF gốc đã tiêu thụ allocated/damaged bao nhiêu thì khi đảo
 * phải cộng lại đúng phần đó — hàm này tính lại theo cùng quy tắc tại thời điểm
 * đảo; nếu trạng thái đã thay đổi nhiều kể từ movement gốc, tầng nghiệp vụ nên
 * kiểm tra tay thay vì đảo tự động.
 */
export function applyReversal(balance: StockBalance, original: StockMovement): StockBalance {
  validateMovement(original)
  const inverse: StockMovement = { ...original }
  const cur: StockBuckets = {
    on_hand: balance.on_hand, allocated: balance.allocated, hold: balance.hold,
    damaged: balance.damaged, inspect: balance.inspect, in_transit: balance.in_transit,
  }
  switch (original.type) {
    case 'RECEIVE':
    case 'RETURN_IN':
    case 'ADJUST_IN':
      return applyMovementToBalance(balance, { ...inverse, type: 'ADJUST_OUT', reason_code: original.reason_code ?? 'INPUT_ERROR' })
    case 'ADJUST_OUT':
      return applyMovementToBalance(balance, { ...inverse, type: 'ADJUST_IN', reason_code: original.reason_code ?? 'INPUT_ERROR' })
    case 'PUTAWAY':
      return finish(balance, { ...cur, inspect: cur.inspect + original.qty })
    case 'ALLOCATE':
      return applyMovementToBalance(balance, { ...inverse, type: 'DEALLOCATE' })
    case 'DEALLOCATE':
      return applyMovementToBalance(balance, { ...inverse, type: 'ALLOCATE' })
    case 'FREEZE':
      return applyMovementToBalance(balance, { ...inverse, type: 'UNFREEZE' })
    case 'UNFREEZE':
      return applyMovementToBalance(balance, { ...inverse, type: 'FREEZE' })
    case 'DAMAGE':
      return finish(balance, { ...cur, damaged: cur.damaged - original.qty })
    case 'TRANSFER_OUT':
      return applyMovementToBalance(balance, { ...inverse, type: 'TRANSFER_IN' })
    case 'TRANSFER_IN':
      return applyMovementToBalance(balance, { ...inverse, type: 'TRANSFER_OUT' })
    case 'PICK':
      return finish(balance, { ...cur, on_hand: cur.on_hand + original.qty })
    case 'WRITE_OFF':
      return finish(balance, { ...cur, on_hand: cur.on_hand + original.qty })
    case 'MOVE':
      return balance
    case 'REVERSAL':
      throw new Error('Không đảo một REVERSAL bằng applyReversal')
  }
}
