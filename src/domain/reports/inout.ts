// Báo cáo Nhập–Xuất–Tồn theo kỳ (GĐ5), tính trên on_hand từ stock_movements.
// Phân loại theo HIỆU ỨNG on_hand thực tế (xem ledger/apply.ts):
//   NHẬP (on_hand tăng): RECEIVE, RETURN_IN, ADJUST_IN, TRANSFER_IN
//   XUẤT (on_hand giảm): PICK, ADJUST_OUT, WRITE_OFF, TRANSFER_OUT
//   TRUNG TÍNH (không đổi on_hand): ALLOCATE, DEALLOCATE, FREEZE, UNFREEZE,
//     DAMAGE (chỉ chuyển sang xô damaged), PUTAWAY, MOVE (chỉ đổi vị trí).
//   REVERSAL: tính theo chiều ngược của movement gốc.
// closing = opening + in − out và phải khớp tổng stock_balances.on_hand tại
// thời điểm cuối kỳ khi dữ liệu movements đầy đủ (test kiểm tính chất này).
import { roundQty, type MovementType, type StockMovement } from '../ledger/types.ts'
import { onHandDelta } from './effects.ts'

export const IN_TYPES: readonly MovementType[] = ['RECEIVE', 'RETURN_IN', 'ADJUST_IN', 'TRANSFER_IN']
export const OUT_TYPES: readonly MovementType[] = ['PICK', 'ADJUST_OUT', 'WRITE_OFF', 'TRANSFER_OUT']
export const NEUTRAL_TYPES: readonly MovementType[] = [
  'ALLOCATE', 'DEALLOCATE', 'FREEZE', 'UNFREEZE', 'DAMAGE', 'PUTAWAY', 'MOVE',
]

export type InOutClass = 'IN' | 'OUT' | 'NEUTRAL'

export function classifyMovement(
  m: StockMovement,
  originalOf?: (id: number) => StockMovement | undefined,
): InOutClass {
  const d = onHandDelta(m, originalOf)
  return d > 0 ? 'IN' : d < 0 ? 'OUT' : 'NEUTRAL'
}

export interface InOutRow {
  sku: string
  opening: number
  in_qty: number
  out_qty: number
  closing: number
}

export interface InOutOptions {
  /** Ngày 'YYYY-MM-DD', gồm cả hai đầu kỳ. */
  from: string
  to: string
  /** Lọc theo kho (movement.warehouse_id); bỏ trống = mọi kho. */
  warehouse_id?: number | null
}

const dayOf = (m: StockMovement) => (m.created_at ?? '').slice(0, 10)
const skuKey = (s: string) => s.trim().toUpperCase()

export function buildInOutReport(movements: StockMovement[], opts: InOutOptions): InOutRow[] {
  const byId = new Map<number, StockMovement>()
  for (const m of movements) if (m.id != null) byId.set(m.id, m)
  const originalOf = (id: number) => byId.get(id)
  const acc = new Map<string, { sku: string; opening: number; in_qty: number; out_qty: number }>()
  const get = (sku: string) => {
    const k = skuKey(sku)
    let v = acc.get(k)
    if (!v) { v = { sku, opening: 0, in_qty: 0, out_qty: 0 }; acc.set(k, v) }
    return v
  }
  for (const m of movements) {
    if (opts.warehouse_id != null && m.warehouse_id !== opts.warehouse_id) continue
    const day = dayOf(m)
    if (!day || day > opts.to) continue // sau kỳ: bỏ qua hẳn
    const d = onHandDelta(m, originalOf)
    if (d === 0) continue
    const v = get(m.sku)
    if (day < opts.from) v.opening = roundQty(v.opening + d)
    else if (d > 0) v.in_qty = roundQty(v.in_qty + d)
    else v.out_qty = roundQty(v.out_qty - d)
  }
  return [...acc.values()]
    .map((v) => ({ ...v, closing: roundQty(v.opening + v.in_qty - v.out_qty) }))
    .sort((a, b) => skuKey(a.sku).localeCompare(skuKey(b.sku)))
}
