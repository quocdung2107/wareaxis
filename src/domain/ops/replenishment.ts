// Gợi ý đặt hàng lại theo min/max (replenishment) — thuần, không DB (GĐ3).
// Công thức (kế hoạch GĐ3, mẫu repo VN): khi tồn khả dụng chạm ngưỡng đặt lại
// (available <= reorder_point nếu có đặt; không thì available < min_qty) thì
//   suggested = max_qty − available − on_order   (bỏ qua nếu <= 0)
// on_order = số đang đặt trên các PO chưa nhận đủ (DRAFT/SENT/PARTIAL) — trừ
// đi để không đặt trùng phần hàng đang về.
import { roundQty } from '../ledger/types.ts'

export interface PolicyForSuggest {
  sku: string
  warehouse_id: number | null
  min_qty: number | null
  max_qty: number | null
  reorder_point: number | null
  reorder_qty: number | null
}

export interface ReplenishmentSuggestion {
  sku: string
  warehouse_id: number | null
  available: number
  on_order: number
  min_qty: number | null
  max_qty: number | null
  reorder_point: number | null
  suggested_qty: number
}

const keyOf = (warehouseId: number | null, sku: string) =>
  `${warehouseId ?? ''}\u0001${sku.trim().toUpperCase()}`

/**
 * Tính gợi ý cho từng policy. availableBySku / onOrderBySku tra theo khoá
 * (warehouse_id, sku) — xem keyOf; thiếu khoá coi như 0.
 */
export function computeSuggestions(
  policies: readonly PolicyForSuggest[],
  availableBySku: ReadonlyMap<string, number>,
  onOrderBySku: ReadonlyMap<string, number>,
): ReplenishmentSuggestion[] {
  const out: ReplenishmentSuggestion[] = []
  for (const p of policies) {
    const min = p.min_qty ?? null
    const max = p.max_qty ?? null
    const point = p.reorder_point ?? null
    if (min == null && point == null) continue // chưa đặt ngưỡng -> không gợi ý
    const key = keyOf(p.warehouse_id, p.sku)
    const available = roundQty(availableBySku.get(key) ?? 0)
    const onOrder = roundQty(onOrderBySku.get(key) ?? 0)
    const triggered = point != null ? available <= point : available < (min ?? 0)
    if (!triggered) continue
    // Đích cần bù: ưu tiên max_qty; thiếu max thì bù tới reorder_qty cộng dồn
    // hoặc ít nhất về min/point.
    const target = max ?? (point != null && p.reorder_qty != null
      ? roundQty(point + p.reorder_qty)
      : (max ?? point ?? min ?? 0))
    const suggested = roundQty(target - available - onOrder)
    if (suggested <= 0) continue
    out.push({
      sku: p.sku, warehouse_id: p.warehouse_id, available, on_order: onOrder,
      min_qty: min, max_qty: max, reorder_point: point, suggested_qty: suggested,
    })
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku))
}

export const suggestionKey = keyOf

export interface SupplierGroup {
  supplier_id: number | null
  supplier_name: string
  lines: ReplenishmentSuggestion[]
}

/**
 * Gom gợi ý theo nhà cung cấp mặc định của SKU (products.default_supplier_id).
 * SKU chưa gán NCC mặc định rơi vào nhóm supplier_id = null ("Chưa rõ NCC") —
 * nhóm này KHÔNG tạo được PO nháp, chỉ để cảnh báo người dùng gán NCC trước.
 */
export function groupBySupplier(
  suggestions: readonly ReplenishmentSuggestion[],
  supplierBySku: ReadonlyMap<string, { supplier_id: number; supplier_name: string } | null>,
): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>()
  for (const s of suggestions) {
    const sup = supplierBySku.get(s.sku.trim().toUpperCase()) ?? null
    const key = sup ? `sup:${sup.supplier_id}` : 'none'
    let g = groups.get(key)
    if (!g) {
      g = {
        supplier_id: sup ? sup.supplier_id : null,
        supplier_name: sup ? sup.supplier_name : 'Chưa rõ NCC',
        lines: [],
      }
      groups.set(key, g)
    }
    g.lines.push(s)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.supplier_id == null) return 1
    if (b.supplier_id == null) return -1
    return a.supplier_name.localeCompare(b.supplier_name)
  })
}
