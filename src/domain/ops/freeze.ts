// Đóng băng / mở băng tồn (freeze/hold) theo (lô, vị trí) — thuần, không DB (GĐ3).
// FREEZE chuyển on_hand khả dụng sang xô hold (hàng vẫn trong kho); hàng hold
// đã tự bị loại khỏi allocation ở GĐ2 (availableOf trừ hold). FREEZE không nằm
// trong nhóm REASON_REQUIRED của ledger, nhưng nghiệp vụ kho bắt buộc ghi lý
// do đóng băng — planFreeze kiểm mã thuộc danh mục adjustment_reasons.
import { availableOf, roundQty, type StockBuckets, type StockMovement } from '../ledger/types.ts'
import { REASON_CODES } from '../ledger/reasons.ts'

export interface FreezeTarget extends StockBuckets {
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
}

export type FreezeResult = { ok: true; movement: StockMovement } | { ok: false; error: string }

export function planFreeze(
  target: FreezeTarget,
  input: { qty: number; reason_code?: string | null; note?: string | null },
  ctx: { actor?: string } = {},
): FreezeResult {
  const fail = (error: string): FreezeResult => ({ ok: false, error })
  const qty = input.qty
  if (!Number.isFinite(qty) || qty <= 0) return fail('Số lượng đóng băng phải lớn hơn 0')
  const reason = input.reason_code?.trim() ?? ''
  if (!reason) return fail('Đóng băng bắt buộc chọn lý do')
  if (!REASON_CODES.has(reason)) return fail(`Lý do đóng băng không có trong danh mục: ${reason}`)
  const avail = availableOf(target)
  if (roundQty(qty) > avail + 1e-9) {
    return fail(`Đóng băng vượt tồn khả dụng tại vị trí: cần ${qty}, khả dụng ${avail} (đã trừ giữ chỗ/đóng băng/hỏng/chờ kiểm)`)
  }
  return {
    ok: true,
    movement: {
      type: 'FREEZE',
      warehouse_id: target.warehouse_id,
      location_id: target.location_id,
      lot_id: target.lot_id,
      sku: target.sku,
      qty: roundQty(qty),
      reason_code: reason,
      doc_type: 'MANUAL',
      note: input.note ?? 'Đóng băng tồn',
      actor: ctx.actor ?? 'local',
    },
  }
}

export function planUnfreeze(
  target: FreezeTarget,
  input: { qty: number; note?: string | null },
  ctx: { actor?: string } = {},
): FreezeResult {
  const fail = (error: string): FreezeResult => ({ ok: false, error })
  const qty = input.qty
  if (!Number.isFinite(qty) || qty <= 0) return fail('Số lượng mở băng phải lớn hơn 0')
  if (roundQty(qty) > target.hold + 1e-9) {
    return fail(`Mở băng vượt số đang đóng băng: cần ${qty}, đang băng ${target.hold}`)
  }
  return {
    ok: true,
    movement: {
      type: 'UNFREEZE',
      warehouse_id: target.warehouse_id,
      location_id: target.location_id,
      lot_id: target.lot_id,
      sku: target.sku,
      qty: roundQty(qty),
      doc_type: 'MANUAL',
      note: input.note ?? 'Mở băng tồn',
      actor: ctx.actor ?? 'local',
    },
  }
}
