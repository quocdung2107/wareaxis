// Dựng lại toàn bộ balances từ danh sách movements (sổ cái là sự thật,
// balances chỉ là cache — kế hoạch Phần 5.1). Hàm thuần, dùng cho
// scripts đối chiếu verify-ledger và cho test bất biến Phần 5.5.
import { applyBucketDelta, applyMovementToBalance, applyReversal } from './apply.ts'
import {
  availableOf, emptyBuckets, type StockBalance, type StockMovement,
} from './types.ts'

export const balanceKeyOf = (k: {
  warehouse_id: number | null; location_id: number | null; lot_id: number | null; sku: string
}): string => [k.warehouse_id ?? '', k.location_id ?? '', k.lot_id ?? '', k.sku.trim().toUpperCase()].join('\u0001')

const emptyBalance = (m: StockMovement, locationId: number | null): StockBalance => ({
  warehouse_id: m.warehouse_id, location_id: locationId, lot_id: m.lot_id, sku: m.sku,
  ...emptyBuckets(), available: 0,
})

/**
 * Gấp (fold) movements theo đúng thứ tự truyền vào (tầng gọi sắp xếp theo
 * created_at/id). MOVE được áp hai phía: trừ on_hand ở (from_location_id),
 * cộng on_hand ở (location_id); MOVE thiếu from_location_id bị coi là dữ
 * liệu lỗi và throw, tránh âm thầm sai tồn.
 */
export function rebuildBalances(movements: readonly StockMovement[]): Map<string, StockBalance> {
  const out = new Map<string, StockBalance>()
  const byId = new Map<number, StockMovement>()
  const get = (m: StockMovement, locationId: number | null): StockBalance => {
    const key = balanceKeyOf({ warehouse_id: m.warehouse_id, location_id: locationId, lot_id: m.lot_id, sku: m.sku })
    let b = out.get(key)
    if (!b) { b = emptyBalance(m, locationId); out.set(key, b) }
    return b
  }
  const put = (b: StockBalance) => out.set(balanceKeyOf(b), b)

  for (const m of movements) {
    if (m.id != null) byId.set(m.id, m)
    if (m.type === 'MOVE') {
      if (m.from_location_id == null) throw new Error('MOVE thiếu from_location_id')
      const src = get(m, m.from_location_id)
      put(applyBucketDelta(src, { on_hand: -m.qty }, 'MOVE (trừ nguồn)'))
      const dst = get(m, m.location_id)
      put(applyBucketDelta(dst, { on_hand: m.qty }, 'MOVE (cộng đích)'))
      continue
    }
    if (m.type === 'PUTAWAY' && m.from_location_id != null && m.from_location_id !== m.location_id) {
      // GĐ1: putaway khác vị trí — nguồn (khu nhận): on_hand- và inspect-;
      // đích: on_hand+ (hàng thành khả dụng tại vị trí đích). Khớp recordMovement.
      const src = get(m, m.from_location_id)
      put(applyBucketDelta(src, { on_hand: -m.qty, inspect: -m.qty }, 'PUTAWAY (trừ nguồn)'))
      const dst = get(m, m.location_id)
      put(applyBucketDelta(dst, { on_hand: m.qty }, 'PUTAWAY (cộng đích)'))
      continue
    }
    if (m.type === 'REVERSAL') {
      const original = m.reverses_movement_id != null ? byId.get(m.reverses_movement_id) : undefined
      if (!original) throw new Error(`REVERSAL không tìm thấy movement gốc ${m.reverses_movement_id}`)
      const b = get(m, m.location_id)
      put(applyReversal(b, original))
      continue
    }
    const b = get(m, m.location_id)
    put(applyMovementToBalance(b, m))
  }
  for (const b of out.values()) b.available = availableOf(b)
  return out
}
