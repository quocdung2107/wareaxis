// Thẻ kho điện tử (GĐ5): dựng lại toàn bộ lịch sử của MỘT lô từ stock_movements,
// kèm số dư chạy từng xô sau mỗi dòng. Số dư cuối của thẻ phải khớp tổng
// stock_balances của lô đó (on_hand cộng dồn mọi vị trí) — test kiểm tính chất này.
import { availableOf, roundQty, type StockBuckets, type StockMovement } from '../ledger/types.ts'
import { emptyDelta, lotBucketDelta } from './effects.ts'

export interface StockCardLine {
  movement_id: number | null
  at: string | null
  type: StockMovement['type']
  doc_type: string | null
  doc_id: number | null
  location_id: number | null
  from_location_id: number | null
  qty: number
  reason_code: string | null
  actor: string | null
  note: string | null
  /** Thay đổi từng xô do dòng này gây ra (ở cấp lô). */
  delta: StockBuckets
  /** Số dư các xô của lô ngay sau dòng này. */
  balance_after: StockBuckets
  available_after: number
}

export interface StockCard {
  lines: StockCardLine[]
  closing: StockBuckets
  closing_available: number
}

const byTimeThenId = (a: StockMovement, b: StockMovement) => {
  const ta = a.created_at ?? ''; const tb = b.created_at ?? ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return (a.id ?? 0) - (b.id ?? 0)
}

export function buildStockCard(movements: StockMovement[]): StockCard {
  const sorted = [...movements].sort(byTimeThenId)
  const byId = new Map<number, StockMovement>()
  for (const m of sorted) if (m.id != null) byId.set(m.id, m)
  const running = emptyDelta()
  const lines: StockCardLine[] = sorted.map((m) => {
    const delta = lotBucketDelta(m, running, (id) => byId.get(id))
    for (const k of Object.keys(running) as (keyof StockBuckets)[]) {
      running[k] = roundQty(running[k] + delta[k])
    }
    return {
      movement_id: m.id ?? null,
      at: m.created_at ?? null,
      type: m.type,
      doc_type: m.doc_type ?? null,
      doc_id: m.doc_id ?? null,
      location_id: m.location_id ?? null,
      from_location_id: m.from_location_id ?? null,
      qty: m.qty,
      reason_code: m.reason_code ?? null,
      actor: m.actor ?? null,
      note: m.note ?? null,
      delta,
      balance_after: { ...running },
      available_after: availableOf(running),
    }
  })
  return { lines, closing: { ...running }, closing_available: availableOf(running) }
}
