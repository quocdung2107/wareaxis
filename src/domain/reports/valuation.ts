// Định giá tồn kho theo lô (GĐ5) — "FIFO lot valuation" theo kế hoạch:
// hàng xuất đi theo FEFO/FIFO nên các lô cũ rời kho trước; tồn còn lại của
// từng lô được định giá bằng CHÍNH giá nhập của lô đó (lots.purchase_price).
//
// Cách tính số lượng (quan trọng — các xô trong ledger CHỒNG nhau, xem
// domain/ledger/types.ts: on_hand là tổng vật lý, hold/inspect/damaged/
// allocated là các phần phân loại NẰM TRONG on_hand):
//   qty_physical = on_hand (cộng dồn mọi vị trí của lô)
//   qty_damaged  = damaged (tách cột riêng, định giá riêng, KHÔNG gộp vào
//                  tổng giá trị tồn bán được)
//   qty_valued   = on_hand − damaged (gồm cả phần đang giữ chỗ/đóng băng/chờ QC)
// Lô không có giá nhập (purchase_price null) đi vào nhóm "chưa có giá":
// chỉ thống kê số lượng, KHÔNG tính 0 vào tổng giá trị mà không ghi chú.
import { roundQty } from '../ledger/types.ts'

export interface LotStockInput {
  lot_id: number
  sku: string
  purchase_price: number | null
  on_hand: number
  damaged: number
  expiry_date?: string | null
  batch_no?: string | null
}

export interface LotValuationRow {
  lot_id: number
  sku: string
  purchase_price: number | null
  qty_physical: number
  qty_damaged: number
  qty_valued: number
  /** qty_valued × giá; null khi lô chưa có giá. */
  value: number | null
  /** qty_damaged × giá (tham khảo, không cộng vào tổng); null khi chưa có giá. */
  damaged_value: number | null
  priced: boolean
  expiry_date: string | null
  batch_no: string | null
}

export interface SkuValuationRow {
  sku: string
  qty_valued: number
  qty_damaged: number
  value: number
  lot_count: number
}

export interface ValuationReport {
  rows: LotValuationRow[]
  by_sku: SkuValuationRow[]
  /** Tổng giá trị phần tồn định giá được (không gồm hàng hỏng, không gồm lô chưa có giá). */
  total_value: number
  total_damaged_value: number
  total_qty_valued: number
  total_qty_damaged: number
  unpriced: { lot_count: number; qty_valued: number; qty_damaged: number }
}

const money = (n: number) => Math.round(n * 100) / 100

export function buildValuation(lots: LotStockInput[]): ValuationReport {
  const rows: LotValuationRow[] = []
  for (const l of lots) {
    const onHand = roundQty(l.on_hand)
    const damaged = roundQty(l.damaged)
    if (onHand <= 0 && damaged <= 0) continue // lô không còn tồn vật lý
    const qtyValued = roundQty(Math.max(0, onHand - damaged))
    const priced = l.purchase_price != null && Number.isFinite(l.purchase_price)
    rows.push({
      lot_id: l.lot_id,
      sku: l.sku,
      purchase_price: priced ? l.purchase_price : null,
      qty_physical: onHand,
      qty_damaged: damaged,
      qty_valued: qtyValued,
      value: priced ? money(qtyValued * (l.purchase_price as number)) : null,
      damaged_value: priced ? money(damaged * (l.purchase_price as number)) : null,
      priced,
      expiry_date: l.expiry_date ?? null,
      batch_no: l.batch_no ?? null,
    })
  }
  rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.lot_id - b.lot_id)
  const bySku = new Map<string, SkuValuationRow>()
  const unpriced = { lot_count: 0, qty_valued: 0, qty_damaged: 0 }
  let totalValue = 0; let totalDamagedValue = 0; let totalQtyValued = 0; let totalQtyDamaged = 0
  for (const r of rows) {
    totalQtyValued = roundQty(totalQtyValued + r.qty_valued)
    totalQtyDamaged = roundQty(totalQtyDamaged + r.qty_damaged)
    if (!r.priced) {
      unpriced.lot_count += 1
      unpriced.qty_valued = roundQty(unpriced.qty_valued + r.qty_valued)
      unpriced.qty_damaged = roundQty(unpriced.qty_damaged + r.qty_damaged)
      continue
    }
    totalValue = money(totalValue + (r.value ?? 0))
    totalDamagedValue = money(totalDamagedValue + (r.damaged_value ?? 0))
    const k = r.sku.trim().toUpperCase()
    const s = bySku.get(k) ?? { sku: r.sku, qty_valued: 0, qty_damaged: 0, value: 0, lot_count: 0 }
    s.qty_valued = roundQty(s.qty_valued + r.qty_valued)
    s.qty_damaged = roundQty(s.qty_damaged + r.qty_damaged)
    s.value = money(s.value + (r.value ?? 0))
    s.lot_count += 1
    bySku.set(k, s)
  }
  return {
    rows,
    by_sku: [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
    total_value: totalValue,
    total_damaged_value: totalDamagedValue,
    total_qty_valued: totalQtyValued,
    total_qty_damaged: totalQtyDamaged,
    unpriced,
  }
}
