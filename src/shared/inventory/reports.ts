// Tầng đọc cho Báo cáo GĐ5 (thẻ kho / nhập–xuất–tồn / định giá / đối chiếu /
// nhật ký). CHỈ ĐỌC dữ liệu — không hàm nào ở đây ghi sửa số liệu tồn.
// Mọi con số truy về stock_movements + stock_balances (+ lots, inventory_rows,
// picks, sources cho phía file). Logic tính nằm ở src/domain/reports (thuần).
import { query } from '../db/client.ts'
import { initSchema } from './repo.ts'
import { skuStockInfo } from './history.ts'
import type { StockMovement } from '../../domain/ledger/types.ts'
import { buildStockCard, type StockCard } from '../../domain/reports/stock-card.ts'
import { buildInOutReport, type InOutRow } from '../../domain/reports/inout.ts'
import { buildValuation, type LotStockInput, type ValuationReport } from '../../domain/reports/valuation.ts'
import { buildReconciliation, type ReconRow } from '../../domain/reports/reconciliation.ts'
import { filterMovements, type JournalFilter } from '../../domain/reports/journal.ts'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (v == null ? '' : String(v))
const nnum = (v: unknown) => (v == null ? null : num(v))

type Row = Record<string, unknown>

function toMovement(r: Row): StockMovement {
  return {
    id: r.id as number,
    movement_no: (r.movement_no as string | null) ?? null,
    warehouse_id: nnum(r.warehouse_id),
    location_id: nnum(r.location_id),
    from_location_id: nnum(r.from_location_id),
    from_warehouse_id: nnum(r.from_warehouse_id),
    lot_id: nnum(r.lot_id),
    sku: str(r.sku),
    type: r.type as StockMovement['type'],
    qty: num(r.qty),
    doc_type: (r.doc_type as StockMovement['doc_type']) ?? null,
    doc_id: nnum(r.doc_id),
    doc_line_id: nnum(r.doc_line_id),
    reason_code: (r.reason_code as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    reverses_movement_id: nnum(r.reverses_movement_id),
    into_inspect: num(r.into_inspect) > 0,
    from_inspect: num(r.from_inspect) > 0,
    period: nnum(r.period),
    created_at: (r.created_at as string | null) ?? null,
  }
}

async function allMovements(): Promise<StockMovement[]> {
  const rows = await query('SELECT * FROM stock_movements ORDER BY created_at, id')
  return rows.map(toMovement)
}

// ---------- Thẻ kho ----------
export interface LotOption {
  lot_id: number
  sku: string
  batch_no: string
  expiry_date: string
  status: string
  on_hand: number
}

export async function listReportLots(sku?: string): Promise<LotOption[]> {
  await initSchema()
  const lots = sku
    ? await query('SELECT * FROM lots WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY lot_id', [sku])
    : await query('SELECT * FROM lots ORDER BY sku, lot_id')
  const bal = await query(
    'SELECT lot_id, SUM(on_hand) AS oh FROM stock_balances WHERE lot_id IS NOT NULL GROUP BY lot_id',
  )
  const oh = new Map(bal.map((r) => [r.lot_id as number, num(r.oh)]))
  return lots.map((r) => ({
    lot_id: r.lot_id as number,
    sku: str(r.sku),
    batch_no: str(r.batch_no),
    expiry_date: str(r.expiry_date),
    status: str(r.status),
    on_hand: oh.get(r.lot_id as number) ?? 0,
  }))
}

export async function listMovementSkus(): Promise<string[]> {
  await initSchema()
  const rows = await query('SELECT DISTINCT sku FROM stock_movements ORDER BY sku')
  return rows.map((r) => str(r.sku))
}

export interface StockCardResult {
  card: StockCard
  /** Tổng on_hand của lô theo stock_balances — đối chứng với closing của thẻ. */
  balances_on_hand: number
}

export async function getStockCard(lotId: number): Promise<StockCardResult> {
  await initSchema()
  const rows = await query(
    'SELECT * FROM stock_movements WHERE lot_id = ? ORDER BY created_at, id', [lotId],
  )
  const card = buildStockCard(rows.map(toMovement))
  const [b] = await query(
    'SELECT COALESCE(SUM(on_hand), 0) AS oh FROM stock_balances WHERE lot_id = ?', [lotId],
  )
  return { card, balances_on_hand: num(b?.oh) }
}

// ---------- Nhập–Xuất–Tồn ----------
export interface InOutResult {
  rows: InOutRow[]
  /** closing theo balances hiện tại (mọi thời gian) để đối chứng khi kỳ phủ tới hôm nay. */
  balances_on_hand: Record<string, number>
}

export async function getInOut(from: string, to: string, warehouseId?: number | null): Promise<InOutResult> {
  await initSchema()
  const rows = buildInOutReport(await allMovements(), { from, to, warehouse_id: warehouseId ?? null })
  const bal = warehouseId != null
    ? await query('SELECT sku, SUM(on_hand) AS oh FROM stock_balances WHERE warehouse_id = ? GROUP BY sku', [warehouseId])
    : await query('SELECT sku, SUM(on_hand) AS oh FROM stock_balances GROUP BY sku')
  const balances_on_hand: Record<string, number> = {}
  for (const r of bal) balances_on_hand[str(r.sku)] = num(r.oh)
  return { rows, balances_on_hand }
}

// ---------- Định giá ----------
export async function getValuation(): Promise<ValuationReport> {
  await initSchema()
  const rows = await query(`
    SELECT b.lot_id AS lot_id, b.sku AS sku, l.purchase_price AS purchase_price,
           l.expiry_date AS expiry_date, l.batch_no AS batch_no,
           SUM(b.on_hand) AS on_hand, SUM(b.damaged) AS damaged
    FROM stock_balances b LEFT JOIN lots l ON l.lot_id = b.lot_id
    WHERE b.lot_id IS NOT NULL
    GROUP BY b.lot_id, b.sku, l.purchase_price, l.expiry_date, l.batch_no`)
  const inputs: LotStockInput[] = rows.map((r) => ({
    lot_id: r.lot_id as number,
    sku: str(r.sku),
    purchase_price: r.purchase_price == null ? null : num(r.purchase_price),
    on_hand: num(r.on_hand),
    damaged: num(r.damaged),
    expiry_date: (r.expiry_date as string | null) ?? null,
    batch_no: (r.batch_no as string | null) ?? null,
  }))
  return buildValuation(inputs)
}

// ---------- Đối chiếu MISA/file ----------
/**
 * file_qty theo đúng công thức app đang hiển thị (history.skuStockInfo):
 *   Σ inventory_rows.qty_system (dòng thuộc kỳ hiện hành — nạp lại file thay
 *   toàn bộ dòng của nguồn) − Σ picks có picked_at >= loaded_at của nguồn.
 * inventory_edits đã được áp thẳng vào qty_system khi sửa nên không trừ thêm.
 */
export async function getFileStockBySku(): Promise<Map<string, number>> {
  await initSchema()
  const rows = await query('SELECT sku, qty_system FROM inventory_rows')
  const picks = await query('SELECT sku, source, qty, picked_at FROM picks')
  const srcs = await query('SELECT name, loaded_at FROM sources')
  const loadedAt = Object.fromEntries(srcs.map((s) => [str(s.name), str(s.loaded_at)]))
  const info = skuStockInfo(
    rows.map((r) => ({ sku: str(r.sku), qty_system: r.qty_system == null ? null : num(r.qty_system) })),
    picks.map((p) => ({
      sku: str(p.sku), source: (p.source as string | null) ?? null,
      location: null, batch_no: null,
      qty: num(p.qty), picked_at: (p.picked_at as string | null) ?? null,
    })),
    loadedAt,
  )
  const out = new Map<string, number>()
  for (const [k, v] of info) out.set(k, v.estimate)
  return out
}

export async function getReconciliation(): Promise<ReconRow[]> {
  await initSchema()
  const bal = await query('SELECT sku, SUM(on_hand) AS oh FROM stock_balances GROUP BY sku')
  const ledger = new Map<string, number>()
  for (const r of bal) ledger.set(str(r.sku), num(r.oh))
  const file = await getFileStockBySku()
  // skuStockInfo key hoá bằng skuKey (đã chuẩn hoá) — buildReconciliation tự gộp khoá.
  return buildReconciliation(ledger, file)
}

// ---------- Nhật ký ----------
export async function getJournal(filter: JournalFilter, limit = 500): Promise<StockMovement[]> {
  await initSchema()
  const rows = await query('SELECT * FROM stock_movements ORDER BY id DESC LIMIT 2000')
  const all = rows.map(toMovement)
  return filterMovements(all, filter).slice(0, limit)
}

export async function listMovementActors(): Promise<string[]> {
  await initSchema()
  const rows = await query('SELECT DISTINCT actor FROM stock_movements WHERE actor IS NOT NULL ORDER BY actor')
  return rows.map((r) => str(r.actor)).filter(Boolean)
}

// ---------- Tổng quan đầu trang báo cáo ----------
export interface ReportOverview {
  sku_with_stock: number
  total_available: number
  total_value: number
  unpriced_lots: number
  open_alerts: number
}

export async function getReportOverview(): Promise<ReportOverview> {
  await initSchema()
  const [skuRow] = await query(
    'SELECT COUNT(DISTINCT UPPER(TRIM(sku))) AS n FROM stock_balances WHERE on_hand > 0',
  )
  const bal = await query('SELECT on_hand, allocated, hold, damaged, inspect FROM stock_balances')
  let avail = 0
  for (const r of bal) {
    avail += num(r.on_hand) - num(r.allocated) - num(r.hold) - num(r.damaged) - num(r.inspect)
  }
  const valuation = await getValuation()
  const [alertRow] = await query("SELECT COUNT(*) AS n FROM alerts WHERE status IN ('NEW', 'ACK')")
  return {
    sku_with_stock: num(skuRow?.n),
    total_available: Math.round(avail * 1e6) / 1e6,
    total_value: valuation.total_value,
    unpriced_lots: valuation.unpriced.lot_count,
    open_alerts: num(alertRow?.n),
  }
}
