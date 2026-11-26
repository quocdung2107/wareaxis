// Hiệu ứng xô của movement ở CẤP LÔ (gộp mọi vị trí của lô) — nền cho thẻ kho
// và báo cáo nhập–xuất–tồn ở GĐ5.
// Nguồn sự thật của hiệu ứng từng movement là src/domain/ledger/apply.ts
// (deltaFor + các nhánh riêng PICK/WRITE_OFF). Ở cấp lô:
//   * MOVE / PUTAWAY khác vị trí: on_hand ròng = 0 (chỉ đổi vị trí); PUTAWAY
//     vẫn trừ xô inspect như deltaFor (hàng rời xô chờ QC).
//   * TRANSFER_OUT / TRANSFER_IN giữ nguyên hiệu ứng deltaFor trên on_hand
//     (xuất chuyển kho làm giảm on_hand tại kho nguồn, nhận làm tăng tại đích).
//   * REVERSAL: đảo đúng hiệu ứng của movement gốc theo applyReversal().
import { deltaFor } from '../ledger/apply.ts'
import type { StockBuckets, StockMovement } from '../ledger/types.ts'

export const emptyDelta = (): StockBuckets => ({
  on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0,
})

/** Delta xô của movement gốc khi bị đảo bởi REVERSAL (khớp applyReversal). */
export function reversalDeltaFor(original: StockMovement): StockBuckets {
  const q = original.qty
  const out = emptyDelta()
  switch (original.type) {
    case 'RECEIVE':
    case 'RETURN_IN':
      out.on_hand = -q
      if (original.into_inspect) out.inspect = -q
      return out
    case 'ADJUST_IN': out.on_hand = -q; return out
    case 'ADJUST_OUT': out.on_hand = q; return out
    case 'PUTAWAY': out.inspect = q; return out
    case 'ALLOCATE': out.allocated = -q; return out
    case 'DEALLOCATE': out.allocated = q; return out
    case 'FREEZE': out.hold = -q; return out
    case 'UNFREEZE': out.hold = q; return out
    case 'DAMAGE':
      out.damaged = -q
      if (original.from_inspect) out.inspect = q
      return out
    case 'TRANSFER_OUT': out.in_transit = -q; out.on_hand = q; return out
    case 'TRANSFER_IN': out.in_transit = q; out.on_hand = -q; return out
    case 'PICK': out.on_hand = q; return out
    case 'WRITE_OFF': out.on_hand = q; return out
    case 'MOVE': return out
    case 'REVERSAL': return out
  }
}

/**
 * Delta xô của một movement ở cấp lô. `running` là số dư chạy của lô (cần cho
 * PICK tiêu thụ allocated trước và WRITE_OFF trừ damaged trước — cùng quy tắc
 * applyMovementToBalance). REVERSAL cần movement gốc: truyền qua `originalOf`.
 */
export function lotBucketDelta(
  m: StockMovement,
  running: StockBuckets,
  originalOf?: (id: number) => StockMovement | undefined,
): StockBuckets {
  const q = m.qty
  const out = emptyDelta()
  switch (m.type) {
    case 'PICK':
      out.on_hand = -q
      out.allocated = -Math.min(running.allocated, q)
      return out
    case 'WRITE_OFF':
      out.on_hand = -q
      out.damaged = -Math.min(running.damaged, q)
      return out
    case 'MOVE':
      return out // chỉ đổi vị trí, tổng lô không đổi
    case 'REVERSAL': {
      const orig = m.reverses_movement_id != null ? originalOf?.(m.reverses_movement_id) : undefined
      return orig ? reversalDeltaFor(orig) : out
    }
    default: {
      const d = deltaFor(m)
      for (const k of Object.keys(out) as (keyof StockBuckets)[]) out[k] = d[k] ?? 0
      return out
    }
  }
}

/**
 * Thay đổi on_hand của một movement (cấp SKU/lô toàn cục, không theo vị trí).
 * PUTAWAY/MOVE/ALLOCATE/DEALLOCATE/FREEZE/UNFREEZE/DAMAGE = 0: DAMAGE chỉ
 * chuyển phần khả dụng sang xô damaged, on_hand vật lý không đổi.
 */
export function onHandDelta(m: StockMovement, originalOf?: (id: number) => StockMovement | undefined): number {
  switch (m.type) {
    case 'RECEIVE':
    case 'RETURN_IN':
    case 'ADJUST_IN':
    case 'TRANSFER_IN':
      return m.qty
    case 'PICK':
    case 'ADJUST_OUT':
    case 'WRITE_OFF':
    case 'TRANSFER_OUT':
      return -m.qty
    case 'REVERSAL': {
      const orig = m.reverses_movement_id != null ? originalOf?.(m.reverses_movement_id) : undefined
      return orig ? -onHandDelta(orig) : 0
    }
    default:
      return 0
  }
}
