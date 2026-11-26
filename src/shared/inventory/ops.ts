// Tầng ghi/đọc cho vận hành kho GĐ3 (kiểm kê quay vòng / đóng băng / chuyển
// kho / gợi ý đặt hàng / cảnh báo) trên SQLite local.
// Logic nghiệp vụ nằm ở src/domain/ops (thuần); file này nạp dữ liệu, gọi
// domain, rồi ghi DB + sổ cái qua recordMovement — cùng phong cách purchase.ts.
// Mọi thay đổi tồn đều qua movement; điều chỉnh kiểm kê bắt buộc reason
// COUNT_VARIANCE và chỉ sinh sau khi phiên được DUYỆT.
import { batch, query } from '../db/client.ts'
import { initSchema } from './repo.ts'
import { listBalances, recordMovement } from './ledger.ts'
import { availableOf, roundQty, type StockBalance } from '../../domain/ledger/types.ts'
import {
  allCounted, buildCountTasks, planCountAdjustments,
  type CountScope, type CountStatus,
} from '../../domain/ops/cycle-count.ts'
import { planFreeze, planUnfreeze } from '../../domain/ops/freeze.ts'
import {
  assertTransferTransition, planMove, planTransferIn, planTransferOut,
  type TransferStatus,
} from '../../domain/ops/transfer.ts'
import {
  computeSuggestions, groupBySupplier, suggestionKey,
  type ReplenishmentSuggestion, type SupplierGroup,
} from '../../domain/ops/replenishment.ts'
import { scanAlerts, type AlertDraft } from '../../domain/ops/alerts.ts'
import { createPurchaseOrder, listLocations, listLots, listSuppliers } from './purchase.ts'

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const todayStamp = () => nowStamp().slice(0, 10)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (v == null ? '' : String(v))
const exec = { query, batch }

// ---------- Kiểu dữ liệu ----------
export interface BalanceDetail extends StockBalance {
  location_code: string
  zone_id: number | null
  lot_status: string
  expiry_date: string
}
export interface CycleCount {
  id: number; count_no: string; scope_type: string
  scope_location_id: number | null; scope_zone_id: number | null; scope_sku: string
  warehouse_id: number | null; blind: number; status: CountStatus; note: string
  counted_by: string; counted_at: string; approved_by: string; approved_at: string
  created_at: string; created_by: string
}
export interface CycleCountTask {
  id: number; count_id: number; warehouse_id: number | null; location_id: number | null
  lot_id: number | null; sku: string; expected_qty: number; hold_qty: number; inspect_qty: number
  counted_qty: number | null; variance: number | null; counted_at: string; counted_by: string
  location_code: string
}
export interface FrozenRow extends StockBalance {
  location_code: string
  reason_code: string; frozen_by: string; frozen_at: string; note: string
}
export interface TransferOrder {
  id: number; transfer_no: string; from_warehouse_id: number | null; to_warehouse_id: number | null
  status: TransferStatus; note: string; created_at: string; created_by: string
  shipped_at: string; shipped_by: string; received_at: string; received_by: string
}
export interface TransferLine {
  id: number; transfer_id: number; sku: string; lot_id: number | null
  from_location_id: number | null; to_location_id: number | null; qty: number
}
export interface StockPolicy {
  id: number; warehouse_id: number | null; sku: string
  min_qty: number | null; max_qty: number | null; reorder_point: number | null
  reorder_qty: number | null; count_class: string
}
export interface ProductSupplier {
  sku: string; name: string; default_supplier_id: number | null; supplier_name: string
  latest_price: number | null
}
export interface AlertRow {
  id: number; alert_key: string; type: string; severity: string; sku: string
  lot_id: number | null; location_id: number | null; message: string; status: string
  created_at: string; updated_at: string; ack_by: string; ack_at: string
}

const toCycleCount = (r: Record<string, unknown>): CycleCount => ({
  id: r.id as number, count_no: str(r.count_no), scope_type: str(r.scope_type),
  scope_location_id: (r.scope_location_id as number | null) ?? null,
  scope_zone_id: (r.scope_zone_id as number | null) ?? null, scope_sku: str(r.scope_sku),
  warehouse_id: (r.warehouse_id as number | null) ?? null, blind: num(r.blind),
  status: str(r.status) as CountStatus, note: str(r.note), counted_by: str(r.counted_by),
  counted_at: str(r.counted_at), approved_by: str(r.approved_by), approved_at: str(r.approved_at),
  created_at: str(r.created_at), created_by: str(r.created_by),
})
const toCycleTask = (r: Record<string, unknown>): CycleCountTask => ({
  id: r.id as number, count_id: r.count_id as number,
  warehouse_id: (r.warehouse_id as number | null) ?? null,
  location_id: (r.location_id as number | null) ?? null,
  lot_id: (r.lot_id as number | null) ?? null, sku: str(r.sku),
  expected_qty: num(r.expected_qty), hold_qty: num(r.hold_qty), inspect_qty: num(r.inspect_qty),
  counted_qty: r.counted_qty == null ? null : num(r.counted_qty),
  variance: r.variance == null ? null : num(r.variance),
  counted_at: str(r.counted_at), counted_by: str(r.counted_by), location_code: str(r.location_code),
})
const toTransferOrder = (r: Record<string, unknown>): TransferOrder => ({
  id: r.id as number, transfer_no: str(r.transfer_no),
  from_warehouse_id: (r.from_warehouse_id as number | null) ?? null,
  to_warehouse_id: (r.to_warehouse_id as number | null) ?? null,
  status: str(r.status) as TransferStatus, note: str(r.note), created_at: str(r.created_at),
  created_by: str(r.created_by), shipped_at: str(r.shipped_at), shipped_by: str(r.shipped_by),
  received_at: str(r.received_at), received_by: str(r.received_by),
})
const toTransferLine = (r: Record<string, unknown>): TransferLine => ({
  id: r.id as number, transfer_id: r.transfer_id as number, sku: str(r.sku),
  lot_id: (r.lot_id as number | null) ?? null,
  from_location_id: (r.from_location_id as number | null) ?? null,
  to_location_id: (r.to_location_id as number | null) ?? null, qty: num(r.qty),
})
const toPolicy = (r: Record<string, unknown>): StockPolicy => ({
  id: r.id as number, warehouse_id: (r.warehouse_id as number | null) ?? null, sku: str(r.sku),
  min_qty: r.min_qty == null ? null : num(r.min_qty), max_qty: r.max_qty == null ? null : num(r.max_qty),
  reorder_point: r.reorder_point == null ? null : num(r.reorder_point),
  reorder_qty: r.reorder_qty == null ? null : num(r.reorder_qty), count_class: str(r.count_class),
})
const toAlert = (r: Record<string, unknown>): AlertRow => ({
  id: r.id as number, alert_key: str(r.alert_key), type: str(r.type), severity: str(r.severity),
  sku: str(r.sku), lot_id: (r.lot_id as number | null) ?? null,
  location_id: (r.location_id as number | null) ?? null, message: str(r.message), status: str(r.status),
  created_at: str(r.created_at), updated_at: str(r.updated_at), ack_by: str(r.ack_by), ack_at: str(r.ack_at),
})

/** Balances kèm mã vị trí / khu / trạng thái lô — dữ liệu nền cho cả 5 tab. */
export async function listBalanceDetails(): Promise<BalanceDetail[]> {
  await initSchema()
  const rows = await query(
    `SELECT b.*, COALESCE(loc.code, '') AS location_code, loc.zone_id AS zone_id,
       COALESCE(l.status, '') AS lot_status, COALESCE(l.expiry_date, '') AS expiry_date
     FROM stock_balances b
     LEFT JOIN locations loc ON loc.id = b.location_id
     LEFT JOIN lots l ON l.lot_id = b.lot_id
     ORDER BY b.sku, loc.pick_sequence, b.lot_id`,
  )
  return rows.map((r) => {
    const b: BalanceDetail = {
      warehouse_id: (r.warehouse_id as number | null) ?? null,
      location_id: (r.location_id as number | null) ?? null,
      lot_id: (r.lot_id as number | null) ?? null, sku: str(r.sku),
      on_hand: num(r.on_hand), allocated: num(r.allocated), hold: num(r.hold),
      damaged: num(r.damaged), inspect: num(r.inspect), in_transit: num(r.in_transit),
      available: 0, location_code: str(r.location_code),
      zone_id: (r.zone_id as number | null) ?? null,
      lot_status: str(r.lot_status), expiry_date: str(r.expiry_date),
    }
    b.available = availableOf(b)
    return b
  })
}

async function findBalanceDetail(
  key: { warehouse_id: number | null; location_id: number | null; lot_id: number | null; sku: string },
): Promise<BalanceDetail> {
  const all = await listBalanceDetails()
  const found = all.find((b) =>
    b.warehouse_id === key.warehouse_id && b.location_id === key.location_id
    && b.lot_id === key.lot_id && b.sku.trim().toUpperCase() === key.sku.trim().toUpperCase())
  if (found) return found
  return {
    ...key, on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0,
    available: 0, location_code: '', zone_id: null, lot_status: '', expiry_date: '',
  }
}

// ---------- 1. Kiểm kê quay vòng ----------
export async function createCycleCount(
  scope: CountScope & { blind?: boolean; note?: string },
  actor = 'local',
): Promise<{ id: number; count_no: string; task_count: number }> {
  await initSchema()
  const balances = await listBalanceDetails()
  const tasks = buildCountTasks(balances, scope)
  if (!tasks.length) throw new Error('Phạm vi đã chọn không có dòng tồn nào để kiểm (cần on_hand > 0 hoặc đang đóng băng)')
  const at = nowStamp()
  await batch([
    { sql: 'UPDATE count_counter SET n = n + 1 WHERE id = 1' },
    {
      sql: `INSERT INTO cycle_counts (count_no, scope_type, scope_location_id, scope_zone_id, scope_sku,
              warehouse_id, blind, status, note, created_at, created_by)
            VALUES ((SELECT 'CC-' || printf('%04d', n) FROM count_counter WHERE id = 1), ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      bind: [scope.type, scope.location_id ?? null, scope.zone_id ?? null, scope.sku ?? null,
        scope.warehouse_id ?? null, scope.blind ? 1 : 0, scope.note ?? '', at, actor],
    },
  ])
  const [{ id: idRaw }] = await query('SELECT last_insert_rowid() AS id')
  const id = idRaw as number
  const [row] = await query('SELECT count_no FROM cycle_counts WHERE id = ?', [id])
  await batch(tasks.map((t) => ({
    sql: `INSERT INTO cycle_count_tasks (count_id, warehouse_id, location_id, lot_id, sku,
            expected_qty, hold_qty, inspect_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, t.warehouse_id, t.location_id, t.lot_id, t.sku, t.expected_qty, t.hold_qty, t.inspect_qty],
  })))
  return { id, count_no: str(row.count_no), task_count: tasks.length }
}

export async function listCycleCounts(): Promise<CycleCount[]> {
  await initSchema()
  return (await query('SELECT * FROM cycle_counts ORDER BY id DESC')).map(toCycleCount)
}

export async function getCycleCount(id: number): Promise<{ count: CycleCount; tasks: CycleCountTask[] } | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM cycle_counts WHERE id = ?', [id])
  if (!r) return null
  const tasks = (await query(
    `SELECT t.*, COALESCE(loc.code, '') AS location_code FROM cycle_count_tasks t
     LEFT JOIN locations loc ON loc.id = t.location_id
     WHERE t.count_id = ? ORDER BY loc.pick_sequence, t.sku, t.lot_id`, [id],
  )).map(toCycleTask)
  return { count: toCycleCount(r), tasks }
}

export async function submitCountEntries(
  countId: number,
  entries: { task_id: number; counted_qty: number }[],
  actor = 'local',
): Promise<void> {
  await initSchema()
  const got = await getCycleCount(countId)
  if (!got) throw new Error('Không tìm thấy phiên kiểm kê')
  if (!['OPEN', 'COUNTED'].includes(got.count.status)) {
    throw new Error(`Phiên đang ở trạng thái ${got.count.status}, không nhập số đếm được nữa`)
  }
  const at = nowStamp()
  const stmts: { sql: string; bind?: (string | number | null)[] }[] = []
  for (const e of entries) {
    const task = got.tasks.find((t) => t.id === e.task_id)
    if (!task) throw new Error(`Dòng kiểm #${e.task_id} không thuộc phiên này`)
    if (!Number.isFinite(e.counted_qty) || e.counted_qty < 0) {
      throw new Error(`Số đếm của ${task.sku} không hợp lệ`)
    }
    stmts.push({
      sql: 'UPDATE cycle_count_tasks SET counted_qty = ?, variance = ?, counted_at = ?, counted_by = ? WHERE id = ?',
      bind: [roundQty(e.counted_qty), roundQty(e.counted_qty - task.expected_qty), at, actor, e.task_id],
    })
  }
  if (stmts.length) await batch(stmts)
  const after = await getCycleCount(countId)
  if (after && allCounted(after.tasks)) {
    await batch([{
      sql: "UPDATE cycle_counts SET status = 'COUNTED', counted_by = ?, counted_at = ? WHERE id = ?",
      bind: [actor, at, countId],
    }])
  }
}

/** Duyệt phiên (COUNTED -> APPROVED): ghi người duyệt; chưa sinh movement. */
export async function approveCycleCount(countId: number, actor = 'local'): Promise<void> {
  await initSchema()
  const got = await getCycleCount(countId)
  if (!got) throw new Error('Không tìm thấy phiên kiểm kê')
  if (got.count.status !== 'COUNTED') {
    throw new Error(`Chỉ duyệt được phiên đã đếm xong (đang là ${got.count.status})`)
  }
  await batch([{
    sql: "UPDATE cycle_counts SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?",
    bind: [actor, nowStamp(), countId],
  }])
}

export async function rejectCycleCount(countId: number): Promise<void> {
  await initSchema()
  const got = await getCycleCount(countId)
  if (!got) throw new Error('Không tìm thấy phiên kiểm kê')
  if (!['COUNTED', 'APPROVED'].includes(got.count.status)) {
    throw new Error(`Không từ chối được phiên đang ở trạng thái ${got.count.status}`)
  }
  await batch([{ sql: "UPDATE cycle_counts SET status = 'REJECTED' WHERE id = ?", bind: [countId] }])
}

/** Áp chênh lệch của phiên đã duyệt vào tồn (APPROVED -> APPLIED) qua ledger. */
export async function applyCycleCount(countId: number, actor = 'local'): Promise<{ movements: number }> {
  await initSchema()
  const got = await getCycleCount(countId)
  if (!got) throw new Error('Không tìm thấy phiên kiểm kê')
  if (got.count.status !== 'APPROVED') {
    throw new Error(`Chỉ áp được phiên đã duyệt (đang là ${got.count.status})`)
  }
  const movements = planCountAdjustments(got.tasks, { count_id: countId, actor })
  for (const m of movements) await recordMovement(exec, m)
  await batch([{ sql: "UPDATE cycle_counts SET status = 'APPLIED' WHERE id = ?", bind: [countId] }])
  return { movements: movements.length }
}

// ---------- 2. Đóng băng / mở băng ----------
export async function freezeStock(
  input: { warehouse_id: number | null; location_id: number | null; lot_id: number | null; sku: string; qty: number; reason_code: string; note?: string },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const target = await findBalanceDetail(input)
  const planned = planFreeze(target, input, { actor })
  if (!planned.ok) throw new Error(planned.error)
  await recordMovement(exec, planned.movement)
}

export async function unfreezeStock(
  input: { warehouse_id: number | null; location_id: number | null; lot_id: number | null; sku: string; qty: number; note?: string },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const target = await findBalanceDetail(input)
  const planned = planUnfreeze(target, input, { actor })
  if (!planned.ok) throw new Error(planned.error)
  await recordMovement(exec, planned.movement)
}

/** Danh sách đang đóng băng (hold > 0) kèm lý do/người băng gần nhất. */
export async function listFrozen(): Promise<FrozenRow[]> {
  await initSchema()
  const balances = (await listBalanceDetails()).filter((b) => b.hold > 0)
  const freezes = await query("SELECT * FROM stock_movements WHERE type = 'FREEZE' ORDER BY id DESC")
  return balances.map((b) => {
    const last = freezes.find((m) =>
      (m.warehouse_id as number | null) === b.warehouse_id
      && (m.location_id as number | null) === b.location_id
      && (m.lot_id as number | null) === b.lot_id
      && str(m.sku).trim().toUpperCase() === b.sku.trim().toUpperCase())
    return {
      ...b,
      reason_code: str(last?.reason_code), frozen_by: str(last?.actor),
      frozen_at: str(last?.created_at), note: str(last?.note),
    }
  })
}

// ---------- 3. Chuyển vị trí + phiếu chuyển kho ----------
export async function moveStock(
  input: { warehouse_id: number | null; location_id: number; lot_id: number | null; sku: string; qty: number; to_location_id: number },
  actor = 'local',
): Promise<void> {
  await initSchema()
  const source = await findBalanceDetail({
    warehouse_id: input.warehouse_id, location_id: input.location_id, lot_id: input.lot_id, sku: input.sku,
  })
  const planned = planMove(source, input, { actor })
  if (!planned.ok) throw new Error(planned.error)
  await recordMovement(exec, planned.movement)
  // Gợi ý vị trí hiện tại của lô (lots.location_id): chỉ đổi khi nguồn đã hết hàng.
  if (input.lot_id != null) {
    const after = await findBalanceDetail({
      warehouse_id: input.warehouse_id, location_id: input.location_id, lot_id: input.lot_id, sku: input.sku,
    })
    if (after.on_hand <= 0) {
      await batch([{ sql: 'UPDATE lots SET location_id = ? WHERE lot_id = ?', bind: [input.to_location_id, input.lot_id] }])
    }
  }
}

export async function createTransferOrder(
  input: {
    from_warehouse_id: number; to_warehouse_id: number; note?: string
    lines: { sku: string; lot_id: number | null; from_location_id: number; to_location_id: number; qty: number }[]
  },
  actor = 'local',
): Promise<{ id: number; transfer_no: string }> {
  await initSchema()
  if (input.from_warehouse_id === input.to_warehouse_id) throw new Error('Kho nguồn và kho đích phải khác nhau')
  if (!input.lines.length) throw new Error('Phiếu chuyển cần ít nhất một dòng')
  const locations = await listLocations()
  for (const [i, l] of input.lines.entries()) {
    if (!l.sku?.trim()) throw new Error(`Dòng ${i + 1}: chưa nhập SKU`)
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw new Error(`Dòng ${i + 1}: số lượng chuyển phải lớn hơn 0`)
    const from = locations.find((x) => x.id === l.from_location_id)
    const to = locations.find((x) => x.id === l.to_location_id)
    if (!from || from.warehouse_id !== input.from_warehouse_id) throw new Error(`Dòng ${i + 1}: vị trí nguồn không thuộc kho nguồn`)
    if (!to || to.warehouse_id !== input.to_warehouse_id) throw new Error(`Dòng ${i + 1}: vị trí đích không thuộc kho đích`)
  }
  const at = nowStamp()
  await batch([
    { sql: 'UPDATE transfer_counter SET n = n + 1 WHERE id = 1' },
    {
      sql: `INSERT INTO transfer_orders (transfer_no, from_warehouse_id, to_warehouse_id, status, note, created_at, created_by)
            VALUES ((SELECT 'CK-' || printf('%04d', n) FROM transfer_counter WHERE id = 1), ?, ?, 'DRAFT', ?, ?, ?)`,
      bind: [input.from_warehouse_id, input.to_warehouse_id, input.note ?? '', at, actor],
    },
  ])
  const [{ id: idRaw }] = await query('SELECT last_insert_rowid() AS id')
  const id = idRaw as number
  const [row] = await query('SELECT transfer_no FROM transfer_orders WHERE id = ?', [id])
  await batch(input.lines.map((l) => ({
    sql: 'INSERT INTO transfer_lines (transfer_id, sku, lot_id, from_location_id, to_location_id, qty) VALUES (?, ?, ?, ?, ?, ?)',
    bind: [id, l.sku.trim(), l.lot_id, l.from_location_id, l.to_location_id, l.qty],
  })))
  return { id, transfer_no: str(row.transfer_no) }
}

export async function listTransferOrders(): Promise<TransferOrder[]> {
  await initSchema()
  return (await query('SELECT * FROM transfer_orders ORDER BY id DESC')).map(toTransferOrder)
}

export async function getTransferOrder(id: number): Promise<{ order: TransferOrder; lines: TransferLine[] } | null> {
  await initSchema()
  const [r] = await query('SELECT * FROM transfer_orders WHERE id = ?', [id])
  if (!r) return null
  const lines = (await query('SELECT * FROM transfer_lines WHERE transfer_id = ? ORDER BY id', [id])).map(toTransferLine)
  return { order: toTransferOrder(r), lines }
}

export async function shipTransferOrder(id: number, actor = 'local'): Promise<void> {
  await initSchema()
  const got = await getTransferOrder(id)
  if (!got) throw new Error('Không tìm thấy phiếu chuyển kho')
  assertTransferTransition(got.order.status, 'IN_TRANSIT')
  const balances = await listBalanceDetails()
  const sources = balances.filter((b) => b.warehouse_id === got.order.from_warehouse_id)
  const movements = planTransferOut(got.lines, sources, {
    transfer_id: id, from_warehouse_id: got.order.from_warehouse_id, actor,
  })
  for (const m of movements) await recordMovement(exec, m)
  await batch([{
    sql: "UPDATE transfer_orders SET status = 'IN_TRANSIT', shipped_at = ?, shipped_by = ? WHERE id = ?",
    bind: [nowStamp(), actor, id],
  }])
}

export async function receiveTransferOrder(id: number, actor = 'local'): Promise<void> {
  await initSchema()
  const got = await getTransferOrder(id)
  if (!got) throw new Error('Không tìm thấy phiếu chuyển kho')
  assertTransferTransition(got.order.status, 'DONE')
  const movements = planTransferIn(got.lines, {
    transfer_id: id, from_warehouse_id: got.order.from_warehouse_id,
    to_warehouse_id: got.order.to_warehouse_id, actor,
  })
  for (const m of movements) await recordMovement(exec, m)
  const stmts: { sql: string; bind?: (string | number | null)[] }[] = [{
    sql: "UPDATE transfer_orders SET status = 'DONE', received_at = ?, received_by = ? WHERE id = ?",
    bind: [nowStamp(), actor, id],
  }]
  for (const l of got.lines) {
    if (l.lot_id != null && l.to_location_id != null) {
      stmts.push({ sql: 'UPDATE lots SET location_id = ? WHERE lot_id = ?', bind: [l.to_location_id, l.lot_id] })
    }
  }
  await batch(stmts)
}

export async function cancelTransferOrder(id: number): Promise<void> {
  await initSchema()
  const got = await getTransferOrder(id)
  if (!got) throw new Error('Không tìm thấy phiếu chuyển kho')
  assertTransferTransition(got.order.status, 'CANCELLED')
  await batch([{ sql: "UPDATE transfer_orders SET status = 'CANCELLED' WHERE id = ?", bind: [id] }])
}

// ---------- 4. Chính sách tồn + gợi ý đặt hàng ----------
export async function listPolicies(): Promise<StockPolicy[]> {
  await initSchema()
  return (await query('SELECT * FROM stock_policies ORDER BY sku')).map(toPolicy)
}

export async function upsertPolicy(input: {
  sku: string; warehouse_id?: number | null
  min_qty?: number | null; max_qty?: number | null
  reorder_point?: number | null; reorder_qty?: number | null; count_class?: string
}): Promise<void> {
  await initSchema()
  const sku = input.sku?.trim()
  if (!sku) throw new Error('Chưa nhập SKU cho chính sách tồn')
  const wh = input.warehouse_id ?? null
  const [existing] = await query(
    'SELECT id FROM stock_policies WHERE warehouse_id IS ? AND UPPER(TRIM(sku)) = UPPER(TRIM(?))', [wh, sku],
  )
  const vals: (string | number | null)[] = [
    input.min_qty ?? null, input.max_qty ?? null, input.reorder_point ?? null,
    input.reorder_qty ?? null, input.count_class ?? '',
  ]
  if (existing) {
    await batch([{
      sql: 'UPDATE stock_policies SET min_qty = ?, max_qty = ?, reorder_point = ?, reorder_qty = ?, count_class = ? WHERE id = ?',
      bind: [...vals, existing.id as number],
    }])
  } else {
    await batch([{
      sql: 'INSERT INTO stock_policies (warehouse_id, sku, min_qty, max_qty, reorder_point, reorder_qty, count_class) VALUES (?, ?, ?, ?, ?, ?, ?)',
      bind: [wh, sku, ...vals],
    }])
  }
}

export async function listProductsWithSupplier(): Promise<ProductSupplier[]> {
  await initSchema()
  const rows = await query(
    `SELECT p.sku, COALESCE(p.name, '') AS name, p.default_supplier_id,
       COALESCE(s.name, '') AS supplier_name,
       (SELECT l.purchase_price FROM lots l WHERE UPPER(TRIM(l.sku)) = UPPER(TRIM(p.sku))
          AND l.purchase_price IS NOT NULL ORDER BY l.lot_id DESC LIMIT 1) AS latest_price
     FROM products p LEFT JOIN suppliers s ON s.id = p.default_supplier_id
     ORDER BY p.sku`,
  )
  return rows.map((r) => ({
    sku: str(r.sku), name: str(r.name),
    default_supplier_id: (r.default_supplier_id as number | null) ?? null,
    supplier_name: str(r.supplier_name),
    latest_price: r.latest_price == null ? null : num(r.latest_price),
  }))
}

export async function setDefaultSupplier(sku: string, supplierId: number | null): Promise<void> {
  await initSchema()
  const s = sku?.trim()
  if (!s) throw new Error('Chưa nhập SKU')
  const at = nowStamp()
  await batch([{
    sql: `INSERT INTO products (sku, default_supplier_id, created_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(sku) DO UPDATE SET default_supplier_id = excluded.default_supplier_id, updated_at = excluded.updated_at`,
    bind: [s, supplierId, at, at],
  }])
}

export interface ReplenishmentData {
  suggestions: ReplenishmentSuggestion[]
  groups: SupplierGroup[]
}

export async function getReplenishment(): Promise<ReplenishmentData> {
  await initSchema()
  const policies = await listPolicies()
  const balances = await listBalances(exec)
  const availableBySku = new Map<string, number>()
  for (const b of balances) {
    const k = suggestionKey(b.warehouse_id, b.sku)
    availableBySku.set(k, roundQty((availableBySku.get(k) ?? 0) + b.available))
  }
  const onOrderRows = await query(
    `SELECT po.warehouse_id AS warehouse_id, l.sku AS sku,
       SUM(l.qty_ordered - l.qty_received) AS pending
     FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id
     WHERE po.status IN ('DRAFT', 'SENT', 'PARTIAL')
     GROUP BY po.warehouse_id, l.sku`,
  )
  const onOrderBySku = new Map<string, number>()
  for (const r of onOrderRows) {
    onOrderBySku.set(
      suggestionKey((r.warehouse_id as number | null) ?? null, str(r.sku)),
      Math.max(0, roundQty(num(r.pending))),
    )
  }
  const suggestions = computeSuggestions(policies, availableBySku, onOrderBySku)
  const products = await listProductsWithSupplier()
  const suppliers = await listSuppliers()
  const supName = new Map(suppliers.map((s) => [s.id, s.name]))
  const supplierBySku = new Map<string, { supplier_id: number; supplier_name: string } | null>()
  for (const p of products) {
    supplierBySku.set(p.sku.trim().toUpperCase(), p.default_supplier_id != null
      ? { supplier_id: p.default_supplier_id, supplier_name: supName.get(p.default_supplier_id) ?? p.supplier_name }
      : null)
  }
  return { suggestions, groups: groupBySupplier(suggestions, supplierBySku) }
}

/** Tạo PO nháp DRAFT cho mỗi nhóm (NCC x kho) từ gợi ý hiện tại. */
export async function createDraftPosFromSuggestions(
  actor = 'local',
): Promise<{ created: { po_no: string; supplier_name: string; line_count: number }[]; skipped_unknown_supplier: number }> {
  await initSchema()
  const { groups } = await getReplenishment()
  const products = await listProductsWithSupplier()
  const priceBySku = new Map(products.map((p) => [p.sku.trim().toUpperCase(), p.latest_price]))
  const created: { po_no: string; supplier_name: string; line_count: number }[] = []
  let skipped = 0
  for (const g of groups) {
    if (g.supplier_id == null) { skipped += g.lines.length; continue }
    // Một PO thuộc một kho: tách nhóm theo kho đích của từng gợi ý.
    const byWarehouse = new Map<number | null, ReplenishmentSuggestion[]>()
    for (const l of g.lines) {
      const arr = byWarehouse.get(l.warehouse_id) ?? []
      arr.push(l)
      byWarehouse.set(l.warehouse_id, arr)
    }
    for (const [warehouseId, lines] of byWarehouse) {
      const { po_no } = await createPurchaseOrder({
        supplier_id: g.supplier_id,
        warehouse_id: warehouseId,
        note: 'PO nháp từ gợi ý đặt hàng lại (min/max) — GĐ3',
        lines: lines.map((l) => ({
          sku: l.sku,
          qty_ordered: l.suggested_qty,
          unit_price: priceBySku.get(l.sku.trim().toUpperCase()) ?? null,
        })),
      }, actor)
      created.push({ po_no, supplier_name: g.supplier_name, line_count: lines.length })
    }
  }
  return { created, skipped_unknown_supplier: skipped }
}

// ---------- 5. Cảnh báo ----------
export async function scanAndStoreAlerts(): Promise<{ found: number; resolved: number; alerts: AlertDraft[] }> {
  await initSchema()
  const lots = await listLots()
  const balances = await listBalances(exec)
  const policies = await listPolicies()
  const drafts = scanAlerts({
    lots: lots.map((l) => ({ lot_id: l.lot_id, sku: l.sku, expiry_date: l.expiry_date || null })),
    balances,
    policies,
    today: todayStamp(),
  })
  const at = nowStamp()
  if (drafts.length) {
    await batch(drafts.map((d) => ({
      sql: `INSERT INTO alerts (alert_key, type, severity, sku, lot_id, location_id, message, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)
            ON CONFLICT(alert_key) DO UPDATE SET severity = excluded.severity, message = excluded.message,
              updated_at = excluded.updated_at, resolved_at = NULL,
              status = CASE WHEN alerts.status = 'ACK' THEN 'ACK' ELSE 'NEW' END`,
      bind: [d.alert_key, d.type, d.severity, d.sku, d.lot_id, d.location_id, d.message, at, at],
    })))
  }
  const keys = new Set(drafts.map((d) => d.alert_key))
  const open = await query("SELECT id, alert_key FROM alerts WHERE status IN ('NEW', 'ACK')")
  const stale = open.filter((r) => !keys.has(str(r.alert_key)))
  if (stale.length) {
    await batch(stale.map((r) => ({
      sql: "UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, updated_at = ? WHERE id = ?",
      bind: [at, at, r.id as number],
    })))
  }
  return { found: drafts.length, resolved: stale.length, alerts: drafts }
}

export async function listAlerts(status?: string): Promise<AlertRow[]> {
  await initSchema()
  const rows = status
    ? await query('SELECT * FROM alerts WHERE status = ? ORDER BY id DESC', [status])
    : await query('SELECT * FROM alerts ORDER BY id DESC')
  return rows.map(toAlert)
}

export async function ackAlert(id: number, actor = 'local'): Promise<void> {
  await initSchema()
  const [r] = await query('SELECT status FROM alerts WHERE id = ?', [id])
  if (!r) throw new Error('Không tìm thấy cảnh báo')
  if (str(r.status) === 'RESOLVED') throw new Error('Cảnh báo đã tự hết điều kiện (RESOLVED)')
  await batch([{
    sql: "UPDATE alerts SET status = 'ACK', ack_by = ?, ack_at = ?, updated_at = ? WHERE id = ?",
    bind: [actor, nowStamp(), nowStamp(), id],
  }])
}
