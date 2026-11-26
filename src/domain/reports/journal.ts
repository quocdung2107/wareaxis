// Nhật ký biến động (GĐ5): lọc + tổng hợp nhẹ trên stock_movements.
// Việc truy vấn thật nằm ở tầng repo; domain chỉ lọc theo kỳ/loại/người/SKU
// trên tập đã nạp và đếm tổng theo loại để hiển thị.
import type { MovementType, StockMovement } from '../ledger/types.ts'

export interface JournalFilter {
  from?: string | null // 'YYYY-MM-DD'
  to?: string | null
  type?: MovementType | null
  actor?: string | null
  sku?: string | null
}

export function filterMovements(movements: StockMovement[], f: JournalFilter): StockMovement[] {
  const sku = f.sku?.trim().toUpperCase()
  const actor = f.actor?.trim()
  return movements.filter((m) => {
    const day = (m.created_at ?? '').slice(0, 10)
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
    if (f.type && m.type !== f.type) return false
    if (actor && (m.actor ?? '') !== actor) return false
    if (sku && m.sku.trim().toUpperCase() !== sku) return false
    return true
  })
}

export function summarizeByType(movements: StockMovement[]): { type: MovementType; count: number; qty: number }[] {
  const acc = new Map<MovementType, { count: number; qty: number }>()
  for (const m of movements) {
    const v = acc.get(m.type) ?? { count: 0, qty: 0 }
    v.count += 1
    v.qty = Math.round((v.qty + m.qty) * 1e6) / 1e6
    acc.set(m.type, v)
  }
  return [...acc.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => a.type.localeCompare(b.type))
}
