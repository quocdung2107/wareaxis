// Tầng ghi/đọc cho outbound GĐ2 (đơn xuất -> phân bổ -> wave/pick -> pack ->
// ship -> returns) trên SQLite local. Logic nghiệp vụ ở src/domain/outbound
// (thuần); file này nạp dữ liệu, gọi domain, ghi DB + sổ cái (recordMovement).
//
// RANH GIỚI: outbound chỉ áp cho hàng LEDGER (lots/stock_balances của GĐ1).
// Luồng pick cũ trên inventory_rows và Supabase Orders/Carriers không đổi —
// đơn xuất chỉ LƯU THAM CHIẾU mã đơn Supabase + tên xe dạng text.
import { batch, query } from '../db/client.ts'
import { initSchema } from './repo.ts'
import { recordMovement } from './ledger.ts'
import { roundQty } from '../../domain/ledger/types.ts'
import {
  assertObTransition, obStatusAfterAllocation, validateOutboundInput,
  type ObStatus, type OutboundOrderInput,
} from '../../domain/outbound/outbound-order.ts'
import {
  allocateLine, buildAllocateMovements,
  type AllocationCandidate, type AllocationPolicy,
} from '../../domain/outbound/allocation.ts'
import {
  buildPickTasks, planPickConfirm,
  type AllocationPickState, type WaveAllocationInput,
} from '../../domain/outbound/wave.ts'
import { summarizePack, type PackLineState, type PackScan } from '../../domain/outbound/pack.ts'
import {
  planReturn, planReturnPutaway, planReturnQc, returnStatusAfter,
  type ReturnLineForQc,
} from '../../domain/outbound/returns.ts'
import { lotStatusAfter } from '../../domain/inbound/qc.ts'
import type { PutawayLocation } from '../../domain/inbound/putaway.ts'

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (v == null ? '' : String(v))
const exec = { query, batch }

// ---------- Kiểu dữ liệu ----------
export interface OutboundOrder {
  id: number; order_no: string; source: string; external_ref: string; customer_name: string
  customer_code: string; warehouse_id: number | null; status: ObStatus; carrier_text: string
  note: string; created_at: string; created_by: string
}
export interface OutboundLine {
  id: number; order_id: number; sku: string; description: string; uom: string
  qty_ordered: number; qty_allocated: number; qty_picked: number; qty_packed: number
  qty_shipped: number; note: string; backorder: number
}
export interface Allocation {
  id: number; order_id: number; order_line_id: number; lot_id: number | null
  location_id: number | null; location_code: string; sku: string
  qty_allocated: number; qty_picked: number; qty_shipped: number; status: string
}
export interface Wave {
  id: number; wave_no: string; warehouse_id: number | null; status: string
  carrier_text: string; cutoff: string; note: string; created_at: string; created_by: string
}
export interface PickTask {
  id: number; wave_id: number | null; location_id: number | null; location_code: string
  lot_id: number | null; sku: string; qty_need: number; qty_picked: number
  pick_sequence: number | null; status: string
  parts: { allocation_id: number; qty_covered: number }[]
}
export interface Shipment {
  id: number; shipment_no: string; order_id: number; order_no: string
  carrier_text: string; tracking_text: string; status: string
  shipped_at: string; shipped_by: string
}
export interface ShipmentItem {
  id: number; shipment_id: number; order_line_id: number | null; allocation_id: number | null
  sku: string; lot_id: number | null; location_id: number | null; qty: number; qty_returned: number
}
export interface ReturnDoc {
  id: number; return_no: string; shipment_id: number | null; order_id: number | null
  customer_name: string; status: string; note: string; created_at: string; created_by: string
}
export interface ReturnLine {
  id: number; return_id: number; shipment_item_id: number | null; sku: string
  lot_id: number | null; qty_returned: number; qty_qc_pass: number; qty_qc_fail: number
  qty_putaway: number; qc_status: string; reason: string; damage_reason_code: string
}

const toOrder = (r: Record<string, unknown>): OutboundOrder => ({
  id: r.id as number, order_no: str(r.order_no), source: str(r.source) || 'MANUAL',
  external_ref: str(r.external_ref), customer_name: str(r.customer_name), customer_code: str(r.customer_code),
  warehouse_id: (r.warehouse_id as number | null) ?? null, status: str(r.status) as ObStatus,
  carrier_text: str(r.carrier_text), note: str(r.note), created_at: str(r.created_at), created_by: str(r.created_by),
})
const toLine = (r: Record<string, unknown>): OutboundLine => {
  const qty_ordered = num(r.qty_ordered); const qty_allocated = num(r.qty_allocated)
  return {
    id: r.id as number, order_id: r.order_id as number, sku: str(r.sku), description: str(r.description),
    uom: str(r.uom), qty_ordered, qty_allocated, qty_picked: num(r.qty_picked),
    qty_packed: num(r.qty_packed), qty_shipped: num(r.qty_shipped), note: str(r.note),
    backorder: roundQty(Math.max(0, qty_ordered - qty_allocated)),
  }
}
const toAllocation = (r: Record<string, unknown>): Allocation => ({
  id: r.id as number, order_id: r.order_id as number, order_line_id: r.order_line_id as number,
  lot_id: (r.lot_id as number | null) ?? null, location_id: (r.location_id as number | null) ?? null,
  location_code: str(r.location_code), sku: str(r.sku), qty_allocated: num(r.qty_allocated),
  qty_picked: num(r.qty_picked), qty_shipped: num(r.qty_shipped), status: str(r.status),
})
const toWave = (r: Record<string, unknown>): Wave => ({
  id: r.id as number, wave_no: str(r.wave_no), warehouse_id: (r.warehouse_id as number | null) ?? null,
  status: str(r.status), carrier_text: str(r.carrier_text), cutoff: str(r.cutoff), note: str(r.note),
  created_at: str(r.created_at), created_by: str(r.created_by),
})
const toShipment = (r: Record<string, unknown>): Shipment => ({
  id: r.id as number, shipment_no: str(r.shipment_no), order_id: r.order_id as number,
  order_no: str(r.order_no), carrier_text: str(r.carrier_text), tracking_text: str(r.tracking_text),
  status: str(r.status), shipped_at: str(r.shipped_at), shipped_by: str(r.shipped_by),
})
const toShipmentItem = (r: Record<string, unknown>): ShipmentItem => ({
  id: r.id as number, shipment_id: r.shipment_id as number,
  order_line_id: (r.order_line_id as number | null) ?? null,
  allocation_id: (r.allocation_id as number | null) ?? null, sku: str(r.sku),
  lot_id: (r.lot_id as number | null) ?? null, location_id: (r.location_id as number | null) ?? null,
  qty: num(r.qty), qty_returned: num(r.qty_returned),
})
const toReturn = (r: Record<string, unknown>): ReturnDoc => ({
  id: r.id as number, return_no: str(r.return_no),
  shipment_id: (r.shipment_id as number | null) ?? null, order_id: (r.order_id as number | null) ?? null,
  customer_name: str(r.customer_name), status: str(r.status), note: str(r.note),
  created_at: str(r.created_at), created_by: str(r.created_by),
})
const toReturnLine = (r: Record<string, unknown>): ReturnLine => ({
  id: r.id as number, return_id: r.return_id as number,
  shipment_item_id: (r.shipment_item_id as number | null) ?? null, sku: str(r.sku),
  lot_id: (r.lot_id as number | null) ?? null, qty_returned: num(r.qty_returned),
  qty_qc_pass: num(r.qty_qc_pass), qty_qc_fail: num(r.qty_qc_fail), qty_putaway: num(r.qty_putaway),
  qc_status: str(r.qc_status), reason: str(r.reason), damage_reason_code: str(r.damage_reason_code),
})
const asReturnQcLine = (l: ReturnLine): ReturnLineForQc => ({
  id: l.id, receipt_id: l.return_id, sku: l.sku, lot_id: l.lot_id,
  qty_received: l.qty_returned, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
})

async function defaultWarehouseId(): Promise<number | null> {
  const [w] = await query('SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1')
  return (w?.id as number) ?? null
}

async function findReceivingLocation(warehouseId: number | null): Promise<{ id: number }> {
  let wh = warehouseId
  if (wh == null) wh = await defaultWarehouseId()
  const rows = wh != null
    ? await query("SELECT id FROM locations WHERE warehouse_id = ? AND loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1", [wh])
    : await query("SELECT id FROM locations WHERE loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1")
  if (!rows.length) throw new Error('Chưa có vị trí nhận hàng (loại RECEIVING). Tạo ở trang Kho & vị trí trước.')
  return { id: rows[0].id as number }
}

async function nextCounter(table: 'ob_counter' | 'wave_counter' | 'shipment_counter' | 'return_counter'): Promise<number> {
  await batch([{ sql: `UPDATE ${table} SET n = n + 1 WHERE id = 1` }])
  const [{ n }] = await query(`SELECT n FROM ${table} WHERE id = 1`)
  return num(n)
}

// ---------- Đơn xuất ----------
export async function createOutboundOrder(
  input: OutboundOrderInput,
  actor = 'local',
): Promise<{ id: number; order_no: string }> {
  await initSchema()
  const err = validateOutboundInput(input)
  if (err) throw new Error(err)
  const at = nowStamp()
  const warehouse_id = input.warehouse_id ?? (await defaultWarehouseId())
  const n = await nextCounter('ob_counter')
  const order_no = `XH-${String(n).padStart(4, '0')}`
  await batch([{
    sql: `INSERT INTO outbound_orders (order_no, source, external_ref, customer_name, customer_code,
            warehouse_id, status, carrier_text, note, created_at, updated_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    bind: [order_no, input.source ?? 'MANUAL', input.external_ref ?? '', input.customer_name ?? '',
      input.customer_code ?? '', warehouse_id, input.carrier_text ?? '', input.note ?? '', at, at, actor],
  }])
  const [{ id: idRaw }] = await query('SELECT last_insert_rowid() AS id')
  const id = idRaw as number
  await batch(input.lines.map((l) => ({
    sql: `INSERT INTO outbound_lines (order_id, sku, description, uom, qty_ordered, note) VALUES (?, ?, ?, ?, ?, ?)`,
    bind: [id, l.sku.trim(), l.description ?? '', l.uom ?? '', l.qty_ordered, l.note ?? ''],
  })))
  return { id, order_no }
}

export async function listOutboundOrders(status?: string): Promise<OutboundOrder[]> {
  await initSchema()
  const rows = status
    ? await query('SELECT * FROM outbound_orders WHERE status = ? ORDER BY id DESC', [status])
    : await query('SELECT * FROM outbound_orders ORDER BY id DESC')
  return rows.map(toOrder)
}

export async function getOutboundOrder(id: number): Promise<{
  order: OutboundOrder; lines: OutboundLine[]; allocations: Allocation[]; active_wave_no: string
} | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM outbound_orders WHERE id = ?', [id])
  if (!r) return null
  const lines = (await query('SELECT * FROM outbound_lines WHERE order_id = ? ORDER BY id', [id])).map(toLine)
  const allocations = (await query(
    `SELECT a.*, COALESCE(loc.code, '') AS location_code FROM allocations a
     LEFT JOIN locations loc ON loc.id = a.location_id WHERE a.order_id = ? ORDER BY a.id`, [id],
  )).map(toAllocation)
  const [w] = await query(
    `SELECT w.wave_no FROM wave_orders wo JOIN waves w ON w.id = wo.wave_id
     WHERE wo.order_id = ? AND w.status IN ('OPEN', 'PICKING') ORDER BY w.id DESC LIMIT 1`, [id],
  )
  return { order: toOrder(r), lines, allocations, active_wave_no: w ? str(w.wave_no) : '' }
}

async function loadCandidates(sku: string): Promise<AllocationCandidate[]> {
  const rows = await query(
    `SELECT b.lot_id, b.location_id, b.sku, b.on_hand, b.allocated, b.hold, b.damaged, b.inspect, b.in_transit,
       l.status AS lot_status, l.expiry_date, loc.loc_type, loc.code AS location_code, loc.active AS location_active
     FROM stock_balances b
     JOIN lots l ON l.lot_id = b.lot_id
     JOIN locations loc ON loc.id = b.location_id
     WHERE UPPER(TRIM(b.sku)) = UPPER(TRIM(?)) AND b.lot_id IS NOT NULL AND b.location_id IS NOT NULL`,
    [sku],
  )
  return rows.map((r) => ({
    lot_id: r.lot_id as number, location_id: r.location_id as number, location_code: str(r.location_code),
    sku: str(r.sku), lot_status: str(r.lot_status), loc_type: (r.loc_type as string | null) ?? null,
    location_active: num(r.location_active), expiry_date: r.expiry_date == null ? null : str(r.expiry_date),
    on_hand: num(r.on_hand), allocated: num(r.allocated), hold: num(r.hold),
    damaged: num(r.damaged), inspect: num(r.inspect), in_transit: num(r.in_transit),
  }))
}

/**
 * Phân bổ tồn cho đơn: mỗi dòng lấy phần còn thiếu (đặt − đã cam kết), áp
 * movement ALLOCATE cho từng slice và ghi allocations. Trả tổng kết theo dòng.
 */
export async function applyAllocation(
  orderId: number,
  policy: AllocationPolicy = 'FEFO_THEN_FIFO',
  actor = 'local',
): Promise<{ line_id: number; sku: string; qty_allocated: number; backorder: number }[]> {
  await initSchema()
  const got = await getOutboundOrder(orderId)
  if (!got) throw new Error('Không tìm thấy đơn xuất')
  const { order, lines } = got
  if (order.status !== 'DRAFT' && order.status !== 'PARTIAL_ALLOCATED') {
    throw new Error(`Đơn đang ở trạng thái ${order.status}, không phân bổ thêm được`)
  }
  // Hàng đã cam kết trong lần chạy này cho SKU khác dòng — trừ dần khỏi ứng viên.
  const consumed = new Map<string, number>()
  const results: { line_id: number; sku: string; qty_allocated: number; backorder: number }[] = []
  const committed = new Map(lines.map((l) => [l.id, l.qty_allocated]))

  for (const line of lines) {
    const need = roundQty(line.qty_ordered - line.qty_allocated)
    if (need <= 0) {
      results.push({ line_id: line.id, sku: line.sku, qty_allocated: 0, backorder: 0 })
      continue
    }
    const raw = await loadCandidates(line.sku)
    const adjusted = raw.map((c) => {
      const extra = consumed.get(`${c.location_id}|${c.lot_id}`) ?? 0
      return extra > 0 ? { ...c, allocated: roundQty(c.allocated + extra) } : c
    })
    const result = allocateLine(line.sku, need, adjusted, policy)
    for (const s of result.allocations) {
      await batch([{
        sql: `INSERT INTO allocations (order_id, order_line_id, lot_id, location_id, sku, qty_allocated, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        bind: [orderId, line.id, s.lot_id, s.location_id, line.sku, s.qty, nowStamp()],
      }])
      consumed.set(`${s.location_id}|${s.lot_id}`, roundQty((consumed.get(`${s.location_id}|${s.lot_id}`) ?? 0) + s.qty))
    }
    for (const m of buildAllocateMovements(result.allocations, { id: line.id, sku: line.sku },
      { order_id: orderId, warehouse_id: order.warehouse_id, actor })) {
      await recordMovement(exec, m)
    }
    committed.set(line.id, roundQty((committed.get(line.id) ?? 0) + result.qty_allocated))
    results.push({ line_id: line.id, sku: line.sku, qty_allocated: result.qty_allocated, backorder: result.backorder })
  }

  await batch(lines.map((l) => ({
    sql: 'UPDATE outbound_lines SET qty_allocated = ? WHERE id = ?',
    bind: [committed.get(l.id) ?? l.qty_allocated, l.id],
  })))
  const next = obStatusAfterAllocation(
    lines.map((l) => ({ qty_ordered: l.qty_ordered, qty_allocated: committed.get(l.id) ?? 0 })),
  )
  if (next !== order.status) {
    assertObTransition(order.status, next)
    await batch([{ sql: 'UPDATE outbound_orders SET status = ?, updated_at = ? WHERE id = ?', bind: [next, nowStamp(), orderId] }])
  }
  return results
}

/** Huỷ đơn chưa lấy: nhả mọi giữ chỗ còn lại (DEALLOCATE) rồi CANCELLED. */
export async function cancelOutboundOrder(orderId: number, actor = 'local'): Promise<void> {
  await initSchema()
  const got = await getOutboundOrder(orderId)
  if (!got) throw new Error('Không tìm thấy đơn xuất')
  const { order, allocations } = got
  if (got.active_wave_no) throw new Error(`Đơn đang nằm trong wave ${got.active_wave_no} — không huỷ được`)
  if (allocations.some((a) => a.qty_picked > 0)) {
    throw new Error('Đơn đã lấy hàng một phần — không huỷ được')
  }
  if (order.status !== 'DRAFT' && order.status !== 'ALLOCATED' && order.status !== 'PARTIAL_ALLOCATED') {
    throw new Error(`Đơn đang ở trạng thái ${order.status}, không huỷ được`)
  }
  for (const a of allocations) {
    if (a.status !== 'ACTIVE') continue
    const remaining = roundQty(a.qty_allocated - a.qty_picked)
    if (remaining > 0) {
      await recordMovement(exec, {
        type: 'DEALLOCATE', warehouse_id: order.warehouse_id, location_id: a.location_id,
        lot_id: a.lot_id, sku: a.sku, qty: remaining,
        doc_type: 'PICK_ORDER', doc_id: orderId, doc_line_id: a.order_line_id,
        actor, note: 'Huỷ đơn xuất — nhả giữ chỗ',
      })
    }
    await batch([
      { sql: "UPDATE allocations SET status = 'RELEASED' WHERE id = ?", bind: [a.id] },
      { sql: 'UPDATE outbound_lines SET qty_allocated = qty_allocated - ? WHERE id = ?', bind: [remaining, a.order_line_id] },
    ])
  }
  assertObTransition(order.status, 'CANCELLED')
  await batch([{ sql: "UPDATE outbound_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?", bind: [nowStamp(), orderId] }])
}

// ---------- Wave + Pick ----------
export async function createWave(
  orderIds: number[],
  opts: { carrier_text?: string; cutoff?: string; note?: string } = {},
  actor = 'local',
): Promise<{ wave_id: number; wave_no: string; task_count: number }> {
  await initSchema()
  if (!orderIds.length) throw new Error('Chưa chọn đơn nào cho wave')
  const inputs: WaveAllocationInput[] = []
  let warehouse_id: number | null = null
  for (const oid of orderIds) {
    const got = await getOutboundOrder(oid)
    if (!got) throw new Error(`Không tìm thấy đơn xuất #${oid}`)
    if (got.active_wave_no) throw new Error(`Đơn ${got.order.order_no} đã nằm trong wave ${got.active_wave_no}`)
    if (got.order.status !== 'ALLOCATED' && got.order.status !== 'PARTIAL_ALLOCATED') {
      throw new Error(`Đơn ${got.order.order_no} đang ở trạng thái ${got.order.status}, chưa sẵn sàng lấy hàng`)
    }
    warehouse_id = warehouse_id ?? got.order.warehouse_id
    for (const a of got.allocations) {
      if (a.status !== 'ACTIVE') continue
      const remaining = roundQty(a.qty_allocated - a.qty_picked)
      if (remaining <= 0 || a.location_id == null || a.lot_id == null) continue
      const [loc] = await query('SELECT pick_sequence FROM locations WHERE id = ?', [a.location_id])
      inputs.push({
        allocation_id: a.id, order_id: oid, order_line_id: a.order_line_id,
        lot_id: a.lot_id, location_id: a.location_id, location_code: a.location_code,
        pick_sequence: loc?.pick_sequence == null ? null : num(loc.pick_sequence),
        sku: a.sku, qty_remaining: remaining,
      })
    }
  }
  const tasks = buildPickTasks(inputs)
  if (!tasks.length) throw new Error('Các đơn đã chọn không còn allocation nào cần lấy')
  const n = await nextCounter('wave_counter')
  const wave_no = `WV-${String(n).padStart(4, '0')}`
  const at = nowStamp()
  await batch([{
    sql: `INSERT INTO waves (wave_no, warehouse_id, status, carrier_text, cutoff, note, created_at, created_by)
          VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
    bind: [wave_no, warehouse_id, opts.carrier_text ?? '', opts.cutoff ?? '', opts.note ?? '', at, actor],
  }])
  const [{ id: waveIdRaw }] = await query('SELECT last_insert_rowid() AS id')
  const waveId = waveIdRaw as number
  await batch(orderIds.map((oid) => ({
    sql: 'INSERT INTO wave_orders (wave_id, order_id) VALUES (?, ?)', bind: [waveId, oid],
  })))
  const allocById = new Map(inputs.map((i) => [i.allocation_id, i]))
  for (const t of tasks) {
    const first = allocById.get(t.parts[0].allocation_id)!
    await batch([{
      sql: `INSERT INTO pick_tasks (wave_id, allocation_id, order_id, order_line_id, location_id, location_code,
              lot_id, sku, qty_need, pick_sequence, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      bind: [waveId, first.allocation_id, first.order_id, first.order_line_id, t.location_id,
        t.location_code, t.lot_id, t.sku, t.qty_need, t.pick_sequence, at],
    }])
    const [{ id: taskIdRaw }] = await query('SELECT last_insert_rowid() AS id')
    await batch(t.parts.map((p) => ({
      sql: 'INSERT INTO pick_task_allocations (task_id, allocation_id, qty_covered) VALUES (?, ?, ?)',
      bind: [taskIdRaw as number, p.allocation_id, p.qty],
    })))
  }
  for (const oid of orderIds) {
    const got = await getOutboundOrder(oid)
    if (got && (got.order.status === 'ALLOCATED' || got.order.status === 'PARTIAL_ALLOCATED')) {
      assertObTransition(got.order.status, 'PICKING')
      await batch([{ sql: "UPDATE outbound_orders SET status = 'PICKING', updated_at = ? WHERE id = ?", bind: [nowStamp(), oid] }])
    }
  }
  return { wave_id: waveId, wave_no, task_count: tasks.length }
}

export async function listWaves(): Promise<Wave[]> {
  await initSchema()
  return (await query('SELECT * FROM waves ORDER BY id DESC')).map(toWave)
}

export async function getWave(id: number): Promise<{ wave: Wave; order_nos: string[]; tasks: PickTask[] } | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM waves WHERE id = ?', [id])
  if (!r) return null
  const orderRows = await query(
    'SELECT o.order_no FROM wave_orders wo JOIN outbound_orders o ON o.id = wo.order_id WHERE wo.wave_id = ? ORDER BY o.id', [id],
  )
  const taskRows = await query('SELECT * FROM pick_tasks WHERE wave_id = ? ORDER BY pick_sequence, location_code, id', [id])
  const tasks: PickTask[] = []
  for (const t of taskRows) {
    const parts = await query('SELECT allocation_id, qty_covered FROM pick_task_allocations WHERE task_id = ? ORDER BY allocation_id', [t.id as number])
    tasks.push({
      id: t.id as number, wave_id: (t.wave_id as number | null) ?? null,
      location_id: (t.location_id as number | null) ?? null, location_code: str(t.location_code),
      lot_id: (t.lot_id as number | null) ?? null, sku: str(t.sku), qty_need: num(t.qty_need),
      qty_picked: num(t.qty_picked), pick_sequence: t.pick_sequence == null ? null : num(t.pick_sequence),
      status: str(t.status),
      parts: parts.map((p) => ({ allocation_id: p.allocation_id as number, qty_covered: num(p.qty_covered) })),
    })
  }
  return { wave: toWave(r), order_nos: orderRows.map((x) => str(x.order_no)), tasks }
}

async function loadAllocationRow(id: number): Promise<Allocation> {
  const [r] = await query(
    `SELECT a.*, COALESCE(loc.code, '') AS location_code FROM allocations a
     LEFT JOIN locations loc ON loc.id = a.location_id WHERE a.id = ?`, [id],
  )
  if (!r) throw new Error(`Không tìm thấy allocation #${id}`)
  return toAllocation(r)
}

/** Áp kết quả planPickConfirm: movements + cập nhật allocation/dòng/task. */
async function applyPickPlan(
  states: AllocationPickState[],
  qtyActual: number,
  warehouse_id: number | null,
  actor: string,
): Promise<{ total_picked: number; total_released: number; task_status: 'PICKED' | 'SHORT' }> {
  const planned = planPickConfirm(states, qtyActual, { warehouse_id, actor })
  if (!planned.ok) throw new Error(planned.error)
  for (const m of planned.plan.movements) await recordMovement(exec, m)
  for (const s of planned.plan.per_allocation) {
    await batch([
      { sql: 'UPDATE allocations SET qty_allocated = ?, qty_picked = ?, status = ? WHERE id = ?',
        bind: [s.qty_allocated_after, s.qty_picked_after, s.new_status, s.allocation_id] },
    ])
    const st = states.find((x) => x.allocation_id === s.allocation_id)!
    await batch([{
      sql: 'UPDATE outbound_lines SET qty_picked = qty_picked + ?, qty_allocated = qty_allocated - ? WHERE id = ?',
      bind: [s.qty_pick_now, s.qty_release, st.order_line_id],
    }])
    const [o] = await query('SELECT status FROM outbound_orders WHERE id = ?', [st.order_id])
    if (o && (o.status === 'ALLOCATED' || o.status === 'PARTIAL_ALLOCATED')) {
      await batch([{ sql: "UPDATE outbound_orders SET status = 'PICKING', updated_at = ? WHERE id = ?", bind: [nowStamp(), st.order_id] }])
    }
  }
  return { total_picked: planned.plan.total_picked, total_released: planned.plan.total_released, task_status: planned.plan.task_status }
}

/** Xác nhận lấy cho 1 pick task của wave. */
export async function applyPickConfirm(taskId: number, qtyActual: number, actor = 'local'): Promise<void> {
  await initSchema()
  const [t] = await query('SELECT * FROM pick_tasks WHERE id = ?', [taskId])
  if (!t) throw new Error('Không tìm thấy pick task')
  if (str(t.status) !== 'PENDING') throw new Error(`Task đã xác nhận (trạng thái ${str(t.status)})`)
  const waveId = t.wave_id as number
  const [w] = await query('SELECT * FROM waves WHERE id = ?', [waveId])
  const parts = await query('SELECT allocation_id, qty_covered FROM pick_task_allocations WHERE task_id = ? ORDER BY allocation_id', [taskId])
  const states: AllocationPickState[] = []
  for (const p of parts) {
    const a = await loadAllocationRow(p.allocation_id as number)
    states.push({
      allocation_id: a.id, order_id: a.order_id, order_line_id: a.order_line_id,
      lot_id: a.lot_id ?? 0, location_id: a.location_id ?? 0, sku: a.sku,
      qty_allocated: a.qty_allocated, qty_picked: a.qty_picked, qty_covered: num(p.qty_covered),
    })
  }
  const out = await applyPickPlan(states, qtyActual, w ? (w.warehouse_id as number | null) : null, actor)
  await batch([{
    sql: 'UPDATE pick_tasks SET qty_picked = ?, status = ?, picked_by = ?, picked_at = ? WHERE id = ?',
    bind: [out.total_picked, out.task_status, actor, nowStamp(), taskId],
  }])
  const rest = await query("SELECT COUNT(*) AS n FROM pick_tasks WHERE wave_id = ? AND status = 'PENDING'", [waveId])
  const done = num(rest[0].n) === 0
  await batch([{
    sql: 'UPDATE waves SET status = ? WHERE id = ?', bind: [done ? 'DONE' : 'PICKING', waveId],
  }])
}

/** Xác nhận lấy lẻ cho 1 allocation (đơn không qua wave). */
export async function applyAllocationPick(allocationId: number, qtyActual: number, actor = 'local'): Promise<void> {
  await initSchema()
  const a = await loadAllocationRow(allocationId)
  if (a.status !== 'ACTIVE') throw new Error(`Allocation đang ở trạng thái ${a.status}`)
  const [o] = await query('SELECT warehouse_id FROM outbound_orders WHERE id = ?', [a.order_id])
  await applyPickPlan([{
    allocation_id: a.id, order_id: a.order_id, order_line_id: a.order_line_id,
    lot_id: a.lot_id ?? 0, location_id: a.location_id ?? 0, sku: a.sku,
    qty_allocated: a.qty_allocated, qty_picked: a.qty_picked,
    qty_covered: roundQty(a.qty_allocated - a.qty_picked),
  }], qtyActual, (o?.warehouse_id as number | null) ?? null, actor)
}

// ---------- Pack + Ship ----------
/** Ghi đóng gói (cộng dồn) cho đơn; đủ mọi SKU đã lấy -> PACKED. */
export async function applyPack(
  orderId: number,
  scans: PackScan[],
  actor = 'local',
): Promise<{ complete: boolean; items: { sku: string; qty_packed: number; qty_picked: number }[] }> {
  await initSchema()
  const got = await getOutboundOrder(orderId)
  if (!got) throw new Error('Không tìm thấy đơn xuất')
  if (got.order.status !== 'PICKING') {
    throw new Error(`Đơn đang ở trạng thái ${got.order.status} — cần đang lấy hàng (PICKING) mới đóng gói được`)
  }
  const states: PackLineState[] = got.lines.map((l) => ({ sku: l.sku, qty_picked: l.qty_picked, qty_packed: l.qty_packed }))
  const planned = summarizePack(states, scans)
  if (!planned.ok) throw new Error(planned.error)
  // Phân bổ scan vào từng dòng giống thuật toán domain (dòng đầu còn chỗ trước).
  const working = got.lines.map((l) => ({ ...l }))
  for (const scan of planned.summary.scanned) {
    let left = scan.qty
    for (const l of working) {
      if (left <= 0) break
      if (l.sku.trim().toUpperCase() !== scan.sku.trim().toUpperCase()) continue
      const add = Math.min(roundQty(l.qty_picked - l.qty_packed), left)
      if (add > 0) {
        l.qty_packed = roundQty(l.qty_packed + add)
        left = roundQty(left - add)
      }
    }
  }
  await batch(working.map((l) => ({
    sql: 'UPDATE outbound_lines SET qty_packed = ? WHERE id = ?', bind: [l.qty_packed, l.id],
  })))
  if (planned.summary.complete) {
    assertObTransition(got.order.status, 'PACKED')
    await batch([{ sql: "UPDATE outbound_orders SET status = 'PACKED', updated_at = ? WHERE id = ?", bind: [nowStamp(), orderId] }])
  }
  void actor
  return { complete: planned.summary.complete, items: planned.summary.items }
}

/**
 * Giao hàng: tạo shipment + shipment_items (kèm lot_id từ allocations đã pick
 * — móc truy vết cho returns) và đóng đơn. KHÔNG sinh movement tồn: hàng đã
 * rời on_hand ở bước PICK (sổ cái GĐ0 không có xô "đã lấy chờ giao").
 */
export async function applyShip(
  orderId: number,
  opts: { carrier_text?: string; tracking_text?: string },
  actor = 'local',
): Promise<{ shipment_id: number; shipment_no: string }> {
  await initSchema()
  const got = await getOutboundOrder(orderId)
  if (!got) throw new Error('Không tìm thấy đơn xuất')
  if (got.order.status !== 'PACKED') {
    throw new Error(`Đơn đang ở trạng thái ${got.order.status} — cần đóng gói xong (PACKED) mới giao được`)
  }
  const shippable = got.allocations.filter((a) => roundQty(a.qty_picked - a.qty_shipped) > 0)
  if (!shippable.length) throw new Error('Không có allocation nào đã lấy để giao')
  const n = await nextCounter('shipment_counter')
  const shipment_no = `GH-${String(n).padStart(4, '0')}`
  const at = nowStamp()
  await batch([{
    sql: `INSERT INTO shipments (shipment_no, order_id, carrier_text, tracking_text, status, shipped_at, shipped_by, created_at)
          VALUES (?, ?, ?, ?, 'SHIPPED', ?, ?, ?)`,
    bind: [shipment_no, orderId, opts.carrier_text ?? got.order.carrier_text ?? '',
      opts.tracking_text ?? '', at, actor, at],
  }])
  const [{ id: shipmentIdRaw }] = await query('SELECT last_insert_rowid() AS id')
  const shipmentId = shipmentIdRaw as number
  const stmts: { sql: string; bind?: (string | number | null)[] }[] = []
  for (const a of shippable) {
    const qty = roundQty(a.qty_picked - a.qty_shipped)
    stmts.push({
      sql: `INSERT INTO shipment_items (shipment_id, order_id, order_line_id, allocation_id, sku, lot_id, location_id, qty)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [shipmentId, orderId, a.order_line_id, a.id, a.sku, a.lot_id, a.location_id, qty],
    })
    stmts.push({ sql: 'UPDATE allocations SET qty_shipped = ? WHERE id = ?', bind: [a.qty_picked, a.id] })
  }
  for (const l of got.lines) {
    stmts.push({ sql: 'UPDATE outbound_lines SET qty_shipped = ? WHERE id = ?', bind: [l.qty_picked, l.id] })
  }
  // MVP: SHIPPED -> COMPLETED gộp ngay khi giao (phiếu giao giữ trạng thái SHIPPED).
  stmts.push({ sql: "UPDATE outbound_orders SET status = 'COMPLETED', updated_at = ? WHERE id = ?", bind: [at, orderId] })
  await batch(stmts)
  return { shipment_id: shipmentId, shipment_no }
}

export async function listShipments(): Promise<Shipment[]> {
  await initSchema()
  return (await query(
    `SELECT s.*, COALESCE(o.order_no, '') AS order_no FROM shipments s
     LEFT JOIN outbound_orders o ON o.id = s.order_id ORDER BY s.id DESC`,
  )).map(toShipment)
}

export async function getShipment(id: number): Promise<{ shipment: Shipment; items: ShipmentItem[] } | null> {
  await initSchema()
  const [r] = await query(
    `SELECT s.*, COALESCE(o.order_no, '') AS order_no FROM shipments s
     LEFT JOIN outbound_orders o ON o.id = s.order_id WHERE s.id = ?`, [id],
  )
  if (!r) return null
  const items = (await query('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id', [id])).map(toShipmentItem)
  return { shipment: toShipment(r), items }
}

// ---------- Returns ----------
export async function applyReturn(
  shipmentId: number,
  inputs: { shipment_item_id: number; qty: number; reason?: string }[],
  actor = 'local',
): Promise<{ return_id: number; return_no: string }> {
  await initSchema()
  const ship = await getShipment(shipmentId)
  if (!ship) throw new Error('Không tìm thấy phiếu giao')
  if (!inputs.length) throw new Error('Phiếu trả trống')
  const [orderRow] = await query('SELECT * FROM outbound_orders WHERE id = ?', [ship.shipment.order_id])
  const warehouse_id = (orderRow?.warehouse_id as number | null) ?? null
  const recvLoc = await findReceivingLocation(warehouse_id)
  const at = nowStamp()
  const n = await nextCounter('return_counter')
  const return_no = `TH-${String(n).padStart(4, '0')}`
  await batch([{
    sql: `INSERT INTO returns (return_no, shipment_id, order_id, customer_name, status, created_at, created_by)
          VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?)`,
    bind: [return_no, shipmentId, ship.shipment.order_id, orderRow ? str(orderRow.customer_name) : '', at, actor],
  }])
  const [{ id: returnIdRaw }] = await query('SELECT last_insert_rowid() AS id')
  const returnId = returnIdRaw as number

  for (const inp of inputs) {
    const item = ship.items.find((i) => i.id === inp.shipment_item_id)
    if (!item) throw new Error(`Dòng giao #${inp.shipment_item_id} không thuộc phiếu giao này`)
    // Lô gốc: ưu tiên lot_id trên shipment_item. Không còn/không rõ -> sinh lô
    // mới (từ lot_counter) để hàng trả vẫn truy vết được theo phiếu trả.
    let lotId = item.lot_id
    if (lotId != null) {
      const [lot] = await query('SELECT lot_id FROM lots WHERE lot_id = ?', [lotId])
      if (!lot) lotId = null
    }
    if (lotId == null) {
      const [{ n: counter }] = await query('SELECT n FROM lot_counter WHERE id = 1')
      lotId = num(counter) + 1
      await batch([
        { sql: 'UPDATE lot_counter SET n = ? WHERE id = 1', bind: [lotId] },
        {
          sql: `INSERT INTO lots (lot_id, sku, status, location_id, created_at) VALUES (?, ?, 'INSPECT', ?, ?)`,
          bind: [lotId, item.sku, recvLoc.id, at],
        },
      ])
    }
    const planned = planReturn(
      { id: item.id, sku: item.sku, lot_id: lotId, qty_shipped: item.qty, qty_returned: item.qty_returned },
      inp.qty,
      { warehouse_id, receiving_location_id: recvLoc.id, return_id: returnId, actor },
    )
    if (!planned.ok) throw new Error(planned.error)
    await batch([
      {
        sql: `INSERT INTO return_lines (return_id, shipment_item_id, sku, lot_id, qty_returned, reason)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: [returnId, item.id, item.sku, lotId, inp.qty, inp.reason ?? ''],
      },
      { sql: 'UPDATE shipment_items SET qty_returned = qty_returned + ? WHERE id = ?', bind: [inp.qty, item.id] },
    ])
    item.qty_returned = roundQty(item.qty_returned + inp.qty)
    for (const m of planned.plan.movements) await recordMovement(exec, m)
  }
  return { return_id: returnId, return_no }
}

export async function listReturns(): Promise<ReturnDoc[]> {
  await initSchema()
  return (await query('SELECT * FROM returns ORDER BY id DESC')).map(toReturn)
}

export async function getReturn(id: number): Promise<{ doc: ReturnDoc; lines: ReturnLine[] } | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM returns WHERE id = ?', [id])
  if (!r) return null
  const lines = (await query('SELECT * FROM return_lines WHERE return_id = ? ORDER BY id', [id])).map(toReturnLine)
  return { doc: toReturn(r), lines }
}

async function refreshReturn(returnId: number, changedLineId: number): Promise<void> {
  const got = await getReturn(returnId)
  if (!got) return
  const status = returnStatusAfter(got.lines.map((l) => ({
    qty_received: l.qty_returned, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
  })))
  await batch([{ sql: 'UPDATE returns SET status = ? WHERE id = ?', bind: [status, returnId] }])
  // Trạng thái lô: chỉ cập nhật cho lô SINH RA từ phiếu trả (không có dòng
  // receipt nào tham chiếu) — lô gốc còn tồn ở vị trí khác, giữ nguyên nhãn
  // AVAILABLE của nó; phần trả về được theo dõi qua balances (xô inspect).
  const line = got.lines.find((l) => l.id === changedLineId)
  if (line?.lot_id != null) {
    const refs = await query('SELECT COUNT(*) AS n FROM receipt_lines WHERE lot_id = ?', [line.lot_id])
    if (num(refs[0].n) === 0) {
      await batch([{ sql: 'UPDATE lots SET status = ? WHERE lot_id = ?', bind: [lotStatusAfter(asReturnQcLine(line)), line.lot_id] }])
    }
  }
}

async function returnWarehouseId(doc: ReturnDoc): Promise<number | null> {
  if (doc.order_id == null) return null
  const [o] = await query('SELECT warehouse_id FROM outbound_orders WHERE id = ?', [doc.order_id])
  return (o?.warehouse_id as number | null) ?? null
}

export async function applyReturnQc(
  returnLineId: number,
  input: { qty_pass: number; qty_fail: number; reason_code?: string | null },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const [r] = await query('SELECT * FROM return_lines WHERE id = ?', [returnLineId])
  if (!r) throw new Error('Không tìm thấy dòng hàng trả')
  const line = toReturnLine(r)
  const got = await getReturn(line.return_id)
  if (!got) throw new Error('Không tìm thấy phiếu trả')
  const warehouse_id = await returnWarehouseId(got.doc)
  const recvLoc = await findReceivingLocation(warehouse_id)
  const planned = planReturnQc(asReturnQcLine(line), input, { warehouse_id, receiving_location_id: recvLoc.id, actor })
  if (!planned.ok) throw new Error(planned.error)
  for (const m of planned.plan.movements) await recordMovement(exec, m)
  await batch([{
    sql: `UPDATE return_lines SET qty_qc_pass = ?, qty_qc_fail = ?, qc_status = ?,
            damage_reason_code = COALESCE(?, damage_reason_code) WHERE id = ?`,
    bind: [roundQty(line.qty_qc_pass + planned.plan.qty_pass), roundQty(line.qty_qc_fail + planned.plan.qty_fail),
      planned.plan.qc_status, planned.plan.qty_fail > 0 ? (input.reason_code ?? null) : null, returnLineId],
  }])
  await refreshReturn(line.return_id, returnLineId)
}

export async function applyReturnPutaway(
  returnLineId: number,
  input: { qty: number; to_location_id: number },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const [r] = await query('SELECT * FROM return_lines WHERE id = ?', [returnLineId])
  if (!r) throw new Error('Không tìm thấy dòng hàng trả')
  const line = toReturnLine(r)
  const got = await getReturn(line.return_id)
  if (!got) throw new Error('Không tìm thấy phiếu trả')
  const warehouse_id = await returnWarehouseId(got.doc)
  const recvLoc = await findReceivingLocation(warehouse_id)
  const locRows = await query('SELECT * FROM locations ORDER BY pick_sequence, code')
  const locations = locRows.map((x) => ({
    id: x.id as number, code: str(x.code), zone_id: (x.zone_id as number | null) ?? null,
    loc_type: (x.loc_type as string | null) ?? null,
    pick_sequence: x.pick_sequence == null ? null : num(x.pick_sequence), active: num(x.active),
  })) as PutawayLocation[]
  const planned = planReturnPutaway(asReturnQcLine(line), input,
    { warehouse_id, receiving_location_id: recvLoc.id, actor }, locations)
  if (!planned.ok) throw new Error(planned.error)
  for (const m of planned.plan.movements) await recordMovement(exec, m)
  await batch([
    { sql: 'UPDATE return_lines SET qty_putaway = ? WHERE id = ?', bind: [roundQty(line.qty_putaway + planned.plan.qty), returnLineId] },
    ...(line.lot_id != null
      ? [{ sql: 'UPDATE lots SET location_id = ? WHERE lot_id = ?', bind: [planned.plan.to_location_id, line.lot_id] }]
      : []),
  ])
  await refreshReturn(line.return_id, returnLineId)
}
