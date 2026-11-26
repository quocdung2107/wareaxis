// Tầng ghi/đọc cho inbound GĐ1 (PO -> nhận -> QC -> putaway) trên SQLite local.
// Logic nghiệp vụ nằm ở src/domain/inbound (thuần); file này chỉ nạp dữ liệu,
// gọi domain, rồi ghi DB + sổ cái (recordMovement) — cùng phong cách repo.ts.
//
// RANH GIỚI TỒN (quan trọng): hàng nhận qua PO sống ở lots + stock_balances
// (ledger) với lot_id riêng từ lot_counter. Nó KHÔNG vào inventory_rows, và
// tồn hiển thị của hàng nạp file (inventory_rows, ước tính theo kỳ) không đổi.
import { batch, query } from '../db/client.ts'
import { initSchema } from './repo.ts'
import { recordMovement } from './ledger.ts'
import { roundQty } from '../../domain/ledger/types.ts'
import {
  assertPoTransition, poTotal, validatePoInput,
  type PoStatus, type PurchaseOrderInput,
} from '../../domain/inbound/purchase-order.ts'
import {
  planReceiving, type ReceiveLineInput,
} from '../../domain/inbound/receiving.ts'
import {
  lotStatusAfter, planQc, qtyAwaitingPutaway, qtyPendingQc, type ReceiptLineForQc,
} from '../../domain/inbound/qc.ts'
import { planPutaway, type PutawayLocation } from '../../domain/inbound/putaway.ts'

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (v == null ? '' : String(v))

// ---------- Kiểu dữ liệu ----------
export interface Supplier {
  id: number; code: string; name: string; contact: string; phone: string; email: string
  address: string; tax_code: string; lead_time_days: number | null; active: number
}
export interface PurchaseOrder {
  id: number; po_no: string; supplier_id: number | null; supplier_name: string
  warehouse_id: number | null; expected_date: string; status: PoStatus
  total_amount: number; note: string; created_at: string; created_by: string
}
export interface PoLine {
  id: number; po_id: number; product_id: number | null; sku: string; description: string
  uom: string; qty_ordered: number; qty_received: number; qty_damaged: number
  unit_price: number | null; expected_batch: string; note: string
}
export interface Receipt {
  id: number; receipt_no: string; po_id: number | null; warehouse_id: number | null
  received_by: string; received_at: string; status: string
}
export interface ReceiptLine {
  id: number; receipt_id: number; po_line_id: number | null; sku: string
  qty_expected: number; qty_received: number; qty_good: number; qty_damaged: number
  qty_shortage: number; qty_more: number; lot_id: number | null; qc_status: string
  qty_qc_pass: number; qty_qc_fail: number; qty_putaway: number; damage_reason_code: string
}
export interface Lot {
  lot_id: number; sku: string; product_id: number | null; batch_no: string; lot_no: string
  manuf_date: string; expiry_date: string; supplier_id: number | null; purchase_price: number | null
  status: string; source_po_id: number | null; location_id: number | null
}
export interface WarehouseRow { id: number; code: string; name: string; is_default: number; active: number }
export interface ZoneRow { id: number; warehouse_id: number | null; code: string; name: string; zone_type: string }
export interface LocationRow {
  id: number; warehouse_id: number | null; zone_id: number | null; code: string
  loc_type: string; pick_sequence: number | null; active: number
}

const toSupplier = (r: Record<string, unknown>): Supplier => ({
  id: r.id as number, code: str(r.code), name: str(r.name), contact: str(r.contact), phone: str(r.phone),
  email: str(r.email), address: str(r.address), tax_code: str(r.tax_code),
  lead_time_days: r.lead_time_days == null ? null : num(r.lead_time_days), active: num(r.active),
})
const toPo = (r: Record<string, unknown>): PurchaseOrder => ({
  id: r.id as number, po_no: str(r.po_no), supplier_id: (r.supplier_id as number | null) ?? null,
  supplier_name: str(r.supplier_name), warehouse_id: (r.warehouse_id as number | null) ?? null,
  expected_date: str(r.expected_date), status: str(r.status) as PoStatus, total_amount: num(r.total_amount),
  note: str(r.note), created_at: str(r.created_at), created_by: str(r.created_by),
})
const toPoLine = (r: Record<string, unknown>): PoLine => ({
  id: r.id as number, po_id: r.po_id as number, product_id: (r.product_id as number | null) ?? null,
  sku: str(r.sku), description: str(r.description), uom: str(r.uom), qty_ordered: num(r.qty_ordered),
  qty_received: num(r.qty_received), qty_damaged: num(r.qty_damaged),
  unit_price: r.unit_price == null ? null : num(r.unit_price), expected_batch: str(r.expected_batch), note: str(r.note),
})
const toReceipt = (r: Record<string, unknown>): Receipt => ({
  id: r.id as number, receipt_no: str(r.receipt_no), po_id: (r.po_id as number | null) ?? null,
  warehouse_id: (r.warehouse_id as number | null) ?? null, received_by: str(r.received_by),
  received_at: str(r.received_at), status: str(r.status),
})
const toReceiptLine = (r: Record<string, unknown>): ReceiptLine => ({
  id: r.id as number, receipt_id: r.receipt_id as number, po_line_id: (r.po_line_id as number | null) ?? null,
  sku: str(r.sku), qty_expected: num(r.qty_expected), qty_received: num(r.qty_received), qty_good: num(r.qty_good),
  qty_damaged: num(r.qty_damaged), qty_shortage: num(r.qty_shortage), qty_more: num(r.qty_more),
  lot_id: (r.lot_id as number | null) ?? null, qc_status: str(r.qc_status), qty_qc_pass: num(r.qty_qc_pass),
  qty_qc_fail: num(r.qty_qc_fail), qty_putaway: num(r.qty_putaway), damage_reason_code: str(r.damage_reason_code),
})
const toLocation = (r: Record<string, unknown>): LocationRow => ({
  id: r.id as number, warehouse_id: (r.warehouse_id as number | null) ?? null,
  zone_id: (r.zone_id as number | null) ?? null, code: str(r.code), loc_type: str(r.loc_type),
  pick_sequence: r.pick_sequence == null ? null : num(r.pick_sequence), active: num(r.active),
})
const asQcLine = (l: ReceiptLine): ReceiptLineForQc => ({
  id: l.id, receipt_id: l.receipt_id, sku: l.sku, lot_id: l.lot_id,
  qty_received: l.qty_received, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
})

// ---------- Nhà cung cấp ----------
export async function listSuppliers(): Promise<Supplier[]> {
  await initSchema()
  return (await query('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE, code')).map(toSupplier)
}

/** Tạo mới (thiếu id) hoặc sửa NCC. Trả lỗi dạng chuỗi, hoặc null khi xong. */
export async function upsertSupplier(input: Partial<Supplier> & { code: string; name: string }): Promise<string | null> {
  await initSchema()
  const code = input.code.trim().toUpperCase()
  const name = input.name.trim()
  if (!code) return 'Chưa nhập mã nhà cung cấp'
  if (!name) return 'Chưa nhập tên nhà cung cấp'
  const dup = await query('SELECT id FROM suppliers WHERE UPPER(code) = ? AND id IS NOT ?', [code, input.id ?? null])
  if (dup.length) return `Mã NCC ${code} đã tồn tại`
  if (input.id) {
    await batch([{
      sql: 'UPDATE suppliers SET code = ?, name = ?, contact = ?, phone = ?, email = ?, address = ?, tax_code = ?, lead_time_days = ? WHERE id = ?',
      bind: [code, name, input.contact ?? '', input.phone ?? '', input.email ?? '', input.address ?? '', input.tax_code ?? '', input.lead_time_days ?? null, input.id],
    }])
  } else {
    await batch([{
      sql: 'INSERT INTO suppliers (code, name, contact, phone, email, address, tax_code, lead_time_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      bind: [code, name, input.contact ?? '', input.phone ?? '', input.email ?? '', input.address ?? '', input.tax_code ?? '', input.lead_time_days ?? null],
    }])
  }
  return null
}

// ---------- Kho / khu / vị trí ----------
export async function listWarehouses(): Promise<WarehouseRow[]> {
  await initSchema()
  return (await query('SELECT * FROM warehouses ORDER BY id')).map((r) => ({
    id: r.id as number, code: str(r.code), name: str(r.name), is_default: num(r.is_default), active: num(r.active),
  }))
}
export async function listZones(): Promise<ZoneRow[]> {
  await initSchema()
  return (await query('SELECT * FROM zones ORDER BY id')).map((r) => ({
    id: r.id as number, warehouse_id: (r.warehouse_id as number | null) ?? null,
    code: str(r.code), name: str(r.name), zone_type: str(r.zone_type),
  }))
}
export async function listLocations(): Promise<LocationRow[]> {
  await initSchema()
  return (await query('SELECT * FROM locations ORDER BY pick_sequence, code')).map(toLocation)
}

export async function createLocation(input: {
  warehouse_id: number; zone_id?: number | null; code: string; loc_type: string; pick_sequence?: number | null
}): Promise<string | null> {
  await initSchema()
  const code = input.code.trim().toUpperCase()
  if (!code) return 'Chưa nhập mã vị trí'
  const dup = await query('SELECT id FROM locations WHERE warehouse_id IS ? AND UPPER(code) = ?', [input.warehouse_id, code])
  if (dup.length) return `Vị trí ${code} đã tồn tại trong kho này`
  await batch([{
    sql: 'INSERT INTO locations (warehouse_id, zone_id, code, loc_type, pick_sequence) VALUES (?, ?, ?, ?, ?)',
    bind: [input.warehouse_id, input.zone_id ?? null, code, input.loc_type, input.pick_sequence ?? null],
  }])
  return null
}

export async function updateLocation(
  id: number,
  patch: Partial<{ code: string; loc_type: string; pick_sequence: number | null; active: number }>,
): Promise<string | null> {
  await initSchema()
  const [row] = await query('SELECT * FROM locations WHERE id = ?', [id])
  if (!row) return 'Không tìm thấy vị trí'
  const cur = toLocation(row)
  const code = (patch.code ?? cur.code).trim().toUpperCase()
  if (!code) return 'Mã vị trí không được trống'
  const dup = await query('SELECT id FROM locations WHERE warehouse_id IS ? AND UPPER(code) = ? AND id IS NOT ?',
    [cur.warehouse_id, code, id])
  if (dup.length) return `Vị trí ${code} đã tồn tại trong kho này`
  await batch([{
    sql: 'UPDATE locations SET code = ?, loc_type = ?, pick_sequence = ?, active = ? WHERE id = ?',
    bind: [code, patch.loc_type ?? cur.loc_type, patch.pick_sequence ?? cur.pick_sequence, patch.active ?? cur.active, id],
  }])
  return null
}

/** Vị trí nhận hàng mặc định của một kho (loc_type RECEIVING, đang bật, đầu tiên). */
async function findReceivingLocation(warehouseId: number | null): Promise<LocationRow> {
  let wh = warehouseId
  if (wh == null) {
    const [w] = await query('SELECT id FROM warehouses WHERE is_default = 1 ORDER BY id LIMIT 1')
    wh = (w?.id as number) ?? null
  }
  const rows = wh != null
    ? await query("SELECT * FROM locations WHERE warehouse_id = ? AND loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1", [wh])
    : await query("SELECT * FROM locations WHERE loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1")
  if (!rows.length) throw new Error('Chưa có vị trí nhận hàng (loại RECEIVING). Tạo ở trang Kho & vị trí trước.')
  return toLocation(rows[0])
}

async function defaultWarehouseId(): Promise<number | null> {
  const [w] = await query('SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1')
  return (w?.id as number) ?? null
}

// ---------- Đơn mua hàng (PO) ----------
export async function createPurchaseOrder(input: PurchaseOrderInput, actor = 'local'): Promise<{ id: number; po_no: string }> {
  await initSchema()
  const err = validatePoInput(input)
  if (err) throw new Error(err)
  const at = nowStamp()
  const warehouse_id = input.warehouse_id ?? (await defaultWarehouseId())
  // Số PO từ po_counter (tăng trong cùng batch, không tái dùng) — mẫu pick_counter.
  await batch([
    { sql: 'UPDATE po_counter SET n = n + 1 WHERE id = 1' },
    {
      sql: `INSERT INTO purchase_orders (po_no, supplier_id, warehouse_id, expected_date, status, total_amount, note, created_at, updated_at, created_by)
            VALUES ((SELECT 'PO-' || printf('%04d', n) FROM po_counter WHERE id = 1), ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      bind: [input.supplier_id ?? null, warehouse_id, input.expected_date ?? '', poTotal(input.lines), input.note ?? '', at, at, actor],
    },
  ])
  const [{ id: idRaw }] = await query('SELECT last_insert_rowid() AS id')
  const id = idRaw as number
  const [poRow] = await query('SELECT po_no FROM purchase_orders WHERE id = ?', [id])
  // Danh mục sản phẩm: upsert theo SKU để lots/po_lines có product_id.
  for (const l of input.lines) {
    await batch([{
      sql: `INSERT INTO products (sku, name, uom, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(sku) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), products.name),
              uom = COALESCE(NULLIF(excluded.uom, ''), products.uom), updated_at = excluded.updated_at`,
      bind: [l.sku.trim(), l.description ?? '', l.uom ?? '', at, at],
    }])
  }
  const prodRows = await query('SELECT id, sku FROM products')
  const prodId = new Map(prodRows.map((r) => [str(r.sku).toUpperCase(), r.id as number]))
  await batch(input.lines.map((l) => ({
    sql: `INSERT INTO po_lines (po_id, product_id, sku, description, uom, qty_ordered, unit_price, expected_batch, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, prodId.get(l.sku.trim().toUpperCase()) ?? null, l.sku.trim(), l.description ?? '', l.uom ?? '',
      l.qty_ordered, l.unit_price ?? null, l.expected_batch ?? '', l.note ?? ''],
  })))
  return { id, po_no: str(poRow.po_no) }
}

export async function listPurchaseOrders(status?: string): Promise<PurchaseOrder[]> {
  await initSchema()
  const rows = status
    ? await query(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = ? ORDER BY po.id DESC`, [status])
    : await query(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po
        LEFT JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC`)
  return rows.map(toPo)
}

export async function getPurchaseOrder(id: number): Promise<{ order: PurchaseOrder; lines: PoLine[] } | null> {
  await initSchema()
  const [r] = await query(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`, [id])
  if (!r) return null
  const lines = (await query('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id', [id])).map(toPoLine)
  return { order: toPo(r), lines }
}

export async function transitionPurchaseOrder(id: number, to: PoStatus): Promise<void> {
  await initSchema()
  const got = await getPurchaseOrder(id)
  if (!got) throw new Error('Không tìm thấy PO')
  assertPoTransition(got.order.status, to)
  await batch([{ sql: 'UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', bind: [to, nowStamp(), id] }])
}

// ---------- Nhận hàng / QC / Putaway ----------
export async function listReceipts(poId?: number): Promise<Receipt[]> {
  await initSchema()
  const rows = poId != null
    ? await query('SELECT * FROM receipts WHERE po_id = ? ORDER BY id DESC', [poId])
    : await query('SELECT * FROM receipts ORDER BY id DESC')
  return rows.map(toReceipt)
}

export async function getReceipt(id: number): Promise<{ receipt: Receipt; lines: ReceiptLine[] } | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM receipts WHERE id = ?', [id])
  if (!r) return null
  const lines = (await query('SELECT * FROM receipt_lines WHERE receipt_id = ? ORDER BY id', [id])).map(toReceiptLine)
  return { receipt: toReceipt(r), lines }
}

/**
 * Áp một lần nhận hàng theo PO: sinh phiếu nhận + lô mới + movement RECEIVE
 * (into_inspect) tại vị trí nhận, cộng dồn po_lines và cập nhật trạng thái PO.
 */
export async function applyReceiving(
  poId: number,
  inputs: ReceiveLineInput[],
  actor = 'local',
): Promise<{ receipt_id: number; receipt_no: string }> {
  await initSchema()
  const got = await getPurchaseOrder(poId)
  if (!got) throw new Error('Không tìm thấy PO')
  const { order, lines } = got
  const recvLoc = await findReceivingLocation(order.warehouse_id)

  // Cấp lot_id trước (theo thứ tự dòng có nhận) để domain lập kế hoạch đủ movement.
  const receivingInputs = inputs.filter((i) => i.qty_received > 0)
  const [{ n: counter }] = await query('SELECT n FROM lot_counter WHERE id = 1')
  let nextLot = num(counter)
  const lotByLine = new Map<number, number>()
  for (const i of receivingInputs) lotByLine.set(i.po_line_id, ++nextLot)
  const withLots = inputs.map((i) => ({ ...i, lot_id: lotByLine.get(i.po_line_id) ?? null }))

  const planned = planReceiving(
    lines.map((l) => ({ id: l.id, sku: l.sku, qty_ordered: l.qty_ordered, qty_received: l.qty_received })),
    withLots,
    { po_id: poId, po_status: order.status, warehouse_id: order.warehouse_id, receiving_location_id: recvLoc.id, actor },
  )
  if (!planned.ok) throw new Error(planned.error)
  const plan = planned.plan
  const at = nowStamp()

  const [{ n: nReceipts }] = await query('SELECT COUNT(*) AS n FROM receipts WHERE po_id = ?', [poId])
  const receipt_no = `${order.po_no}-R${num(nReceipts) + 1}`
  await batch([
    { sql: 'UPDATE lot_counter SET n = ? WHERE id = 1', bind: [nextLot] },
    {
      sql: `INSERT INTO receipts (receipt_no, po_id, warehouse_id, received_by, received_at, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'QC_PENDING', ?)`,
      bind: [receipt_no, poId, order.warehouse_id, actor, at, at],
    },
  ])
  const [{ id: receiptIdRaw }] = await query('SELECT last_insert_rowid() AS id')
  const receiptId = receiptIdRaw as number

  await batch(plan.lines.map((l) => ({
    sql: `INSERT INTO receipt_lines (receipt_id, po_line_id, sku, qty_expected, qty_received, qty_good, qty_damaged,
            qty_shortage, qty_more, lot_id, qc_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    bind: [receiptId, l.po_line_id, l.sku, l.qty_expected, l.qty_received, l.qty_good, l.qty_damaged,
      l.qty_shortage, l.qty_more, l.lot_id],
  })))
  const rlRows = await query('SELECT id, lot_id FROM receipt_lines WHERE receipt_id = ? ORDER BY id', [receiptId])
  const rlIdByLot = new Map(rlRows.map((r) => [r.lot_id as number, r.id as number]))
  const prodRows = await query('SELECT id, sku FROM products')
  const prodId = new Map(prodRows.map((r) => [str(r.sku).toUpperCase(), r.id as number]))

  const stmts: { sql: string; bind?: (string | number | null)[] }[] = []
  for (const l of plan.lines) {
    stmts.push({
      sql: `INSERT INTO lots (lot_id, sku, product_id, batch_no, lot_no, manuf_date, expiry_date, supplier_id,
              purchase_price, status, source_po_id, source_receipt_line_id, location_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INSPECT', ?, ?, ?, ?)`,
      bind: [l.lot_id, l.sku, prodId.get(l.sku.toUpperCase()) ?? null, l.batch_no || null, l.lot_no || null,
        l.manuf_date || null, l.expiry_date || null, order.supplier_id, l.purchase_price,
        poId, rlIdByLot.get(l.lot_id!) ?? null, recvLoc.id, at],
    })
    const poLine = lines.find((x) => x.id === l.po_line_id)!
    stmts.push({
      sql: 'UPDATE po_lines SET qty_received = ?, qty_damaged = ? WHERE id = ?',
      bind: [roundQty(poLine.qty_received + l.qty_received), roundQty(poLine.qty_damaged + l.qty_damaged), l.po_line_id],
    })
  }
  stmts.push({
    sql: 'UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?',
    bind: [plan.next_po_status, at, poId],
  })
  await batch(stmts)

  // Sổ cái: RECEIVE vào inspect tại vị trí nhận cho từng lô (doc_id trỏ receipt).
  for (const m of plan.movements) {
    await recordMovement({ query, batch }, { ...m, doc_id: receiptId })
  }
  return { receipt_id: receiptId, receipt_no }
}

/** Cập nhật trạng thái lô + phiếu nhận sau QC/putaway (suy từ tiến độ dòng). */
async function refreshAfterQcOrPutaway(receiptLineId: number): Promise<void> {
  const [r] = await query('SELECT * FROM receipt_lines WHERE id = ?', [receiptLineId])
  if (!r) return
  const line = toReceiptLine(r)
  if (line.lot_id != null) {
    await batch([{ sql: 'UPDATE lots SET status = ? WHERE lot_id = ?', bind: [lotStatusAfter(asQcLine(line)), line.lot_id] }])
  }
  const siblings = (await query('SELECT * FROM receipt_lines WHERE receipt_id = ?', [line.receipt_id])).map(toReceiptLine)
  const done = siblings.every((l) => qtyPendingQc(asQcLine(l)) <= 0 && qtyAwaitingPutaway(asQcLine(l)) <= 0)
  if (done) {
    await batch([{ sql: "UPDATE receipts SET status = 'DONE' WHERE id = ?", bind: [line.receipt_id] }])
  }
}

export async function applyQc(
  receiptLineId: number,
  input: { qty_pass: number; qty_fail: number; reason_code?: string | null },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const [r] = await query('SELECT * FROM receipt_lines WHERE id = ?', [receiptLineId])
  if (!r) throw new Error('Không tìm thấy dòng phiếu nhận')
  const line = toReceiptLine(r)
  const [rc] = await query('SELECT * FROM receipts WHERE id = ?', [line.receipt_id])
  const warehouse_id = (rc?.warehouse_id as number | null) ?? null
  const recvLoc = await findReceivingLocation(warehouse_id)
  const planned = planQc(asQcLine(line), input, { warehouse_id, receiving_location_id: recvLoc.id, actor })
  if (!planned.ok) throw new Error(planned.error)
  for (const m of planned.plan.movements) await recordMovement({ query, batch }, m)
  await batch([{
    sql: `UPDATE receipt_lines SET qty_qc_pass = ?, qty_qc_fail = ?, qc_status = ?,
            damage_reason_code = COALESCE(?, damage_reason_code) WHERE id = ?`,
    bind: [roundQty(line.qty_qc_pass + planned.plan.qty_pass), roundQty(line.qty_qc_fail + planned.plan.qty_fail),
      planned.plan.qc_status, planned.plan.qty_fail > 0 ? (input.reason_code ?? null) : null, receiptLineId],
  }])
  await refreshAfterQcOrPutaway(receiptLineId)
}

export async function applyPutaway(
  receiptLineId: number,
  input: { qty: number; to_location_id: number },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const [r] = await query('SELECT * FROM receipt_lines WHERE id = ?', [receiptLineId])
  if (!r) throw new Error('Không tìm thấy dòng phiếu nhận')
  const line = toReceiptLine(r)
  const [rc] = await query('SELECT * FROM receipts WHERE id = ?', [line.receipt_id])
  const warehouse_id = (rc?.warehouse_id as number | null) ?? null
  const recvLoc = await findReceivingLocation(warehouse_id)
  const locations = (await listLocations()) as PutawayLocation[]
  const planned = planPutaway(asQcLine(line), input, { warehouse_id, receiving_location_id: recvLoc.id, actor }, locations)
  if (!planned.ok) throw new Error(planned.error)
  for (const m of planned.plan.movements) await recordMovement({ query, batch }, m)
  await batch([
    { sql: 'UPDATE receipt_lines SET qty_putaway = ? WHERE id = ?', bind: [roundQty(line.qty_putaway + planned.plan.qty), receiptLineId] },
    ...(line.lot_id != null
      ? [{ sql: 'UPDATE lots SET location_id = ? WHERE lot_id = ?', bind: [planned.plan.to_location_id, line.lot_id] }]
      : []),
  ])
  await refreshAfterQcOrPutaway(receiptLineId)
}

export async function listLots(sku?: string): Promise<Lot[]> {
  await initSchema()
  const rows = sku
    ? await query('SELECT * FROM lots WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY lot_id', [sku])
    : await query('SELECT * FROM lots ORDER BY lot_id')
  return rows.map((r) => ({
    lot_id: r.lot_id as number, sku: str(r.sku), product_id: (r.product_id as number | null) ?? null,
    batch_no: str(r.batch_no), lot_no: str(r.lot_no), manuf_date: str(r.manuf_date), expiry_date: str(r.expiry_date),
    supplier_id: (r.supplier_id as number | null) ?? null,
    purchase_price: r.purchase_price == null ? null : num(r.purchase_price),
    status: str(r.status), source_po_id: (r.source_po_id as number | null) ?? null,
    location_id: (r.location_id as number | null) ?? null,
  }))
}
