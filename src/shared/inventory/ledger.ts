// Ghi sổ cái tồn kho vào SQLite local (bảng stock_movements + stock_balances).
// Logic cộng/trừ nằm ở src/domain/ledger (thuần); file này chỉ đọc balance hiện tại,
// gọi domain, rồi ghi movement + balance mới trong MỘT batch (giao dịch).
// Append-only: không bao giờ UPDATE/DELETE stock_movements; sai thì ghi REVERSAL.
import { applyBucketDelta, applyMovementToBalance, applyReversal, validateMovement } from '../../domain/ledger/apply.ts'
import {
  availableOf, emptyBuckets,
  type StockBalance, type StockMovement,
} from '../../domain/ledger/types.ts'

export type LedgerBind = (string | number | null)[]
export type LedgerStatement = { sql: string; bind?: LedgerBind }
export type LedgerRow = Record<string, unknown>

/** Tầng thực thi DB tối thiểu (khớp query/batch của shared/db/client.ts). */
export interface LedgerExec {
  query: (sql: string, bind?: LedgerBind) => Promise<LedgerRow[]>
  batch: (statements: LedgerStatement[]) => Promise<unknown>
}

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

async function findBalanceRow(exec: LedgerExec, m: StockMovement, locationId: number | null): Promise<LedgerRow | null> {
  const rows = await exec.query(
    `SELECT * FROM stock_balances
     WHERE warehouse_id IS ? AND location_id IS ? AND lot_id IS ? AND UPPER(TRIM(sku)) = UPPER(TRIM(?))`,
    [m.warehouse_id, locationId, m.lot_id, m.sku],
  )
  return rows[0] ?? null
}

function toBalance(row: LedgerRow | null, m: StockMovement, locationId: number | null): StockBalance {
  if (!row) {
    return {
      warehouse_id: m.warehouse_id, location_id: locationId, lot_id: m.lot_id, sku: m.sku,
      ...emptyBuckets(), available: 0,
    }
  }
  const b: StockBalance = {
    warehouse_id: (row.warehouse_id as number | null) ?? null,
    location_id: (row.location_id as number | null) ?? null,
    lot_id: (row.lot_id as number | null) ?? null,
    sku: String(row.sku ?? m.sku),
    on_hand: num(row.on_hand), allocated: num(row.allocated), hold: num(row.hold),
    damaged: num(row.damaged), inspect: num(row.inspect), in_transit: num(row.in_transit),
    available: 0,
  }
  b.available = availableOf(b)
  return b
}

function balanceStatement(row: LedgerRow | null, b: StockBalance, at: string): LedgerStatement {
  if (row) {
    return {
      sql: `UPDATE stock_balances SET on_hand = ?, allocated = ?, hold = ?, damaged = ?, inspect = ?, in_transit = ?, updated_at = ? WHERE id = ?`,
      bind: [b.on_hand, b.allocated, b.hold, b.damaged, b.inspect, b.in_transit, at, row.id as number],
    }
  }
  return {
    sql: `INSERT INTO stock_balances (warehouse_id, location_id, lot_id, sku, on_hand, allocated, hold, damaged, inspect, in_transit, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [b.warehouse_id, b.location_id, b.lot_id, b.sku, b.on_hand, b.allocated, b.hold, b.damaged, b.inspect, b.in_transit, at],
  }
}

const MOVEMENT_COLS = `movement_no, type, warehouse_id, location_id, from_location_id, lot_id, sku, qty,
  qty_before, qty_after, doc_type, doc_id, doc_line_id, reason_code, note, actor, reverses_movement_id, period, created_at`

function movementStatement(m: StockMovement, qtyBefore: number, qtyAfter: number, at: string): LedgerStatement {
  return {
    sql: `INSERT INTO stock_movements (${MOVEMENT_COLS}) VALUES (${MOVEMENT_COLS.split(',').map(() => '?').join(', ')})`,
    bind: [
      m.movement_no ?? null, m.type, m.warehouse_id, m.location_id, m.from_location_id ?? null, m.lot_id,
      m.sku, m.qty, qtyBefore, qtyAfter, m.doc_type ?? null, m.doc_id ?? null, m.doc_line_id ?? null,
      m.reason_code ?? null, m.note ?? null, m.actor ?? 'local', m.reverses_movement_id ?? null,
      m.period ?? null, m.created_at ?? at,
    ],
  }
}

async function loadMovement(exec: LedgerExec, id: number): Promise<StockMovement> {
  const [r] = await exec.query('SELECT * FROM stock_movements WHERE id = ?', [id])
  if (!r) throw new Error(`Không tìm thấy movement #${id} để đảo`)
  return {
    id: r.id as number,
    warehouse_id: (r.warehouse_id as number | null) ?? null,
    location_id: (r.location_id as number | null) ?? null,
    from_location_id: (r.from_location_id as number | null) ?? null,
    lot_id: (r.lot_id as number | null) ?? null,
    sku: String(r.sku ?? ''),
    type: r.type as StockMovement['type'],
    qty: num(r.qty),
    reason_code: (r.reason_code as string | null) ?? null,
  }
}

/**
 * Ghi 1 movement + cập nhật balances tương ứng, nguyên tử trong 1 batch.
 * Trả id của dòng movement vừa ghi. MOVE áp hai phía (nguồn = from_location_id).
 * REVERSAL tự nạp movement gốc để tính đảo.
 */
export async function recordMovement(exec: LedgerExec, m: StockMovement): Promise<number> {
  validateMovement(m)
  const at = nowStamp()
  const statements: LedgerStatement[] = []

  if (m.type === 'MOVE') {
    if (m.from_location_id == null) throw new Error('MOVE thiếu from_location_id')
    if (m.from_location_id === m.location_id) {
      // Chuyển trong cùng một vị trí: chỉ ghi sổ, số dư không đổi.
      const row = await findBalanceRow(exec, m, m.location_id)
      const cur = toBalance(row, m, m.location_id)
      await exec.batch([movementStatement(m, cur.on_hand, cur.on_hand, at)])
      const [{ id }] = await exec.query('SELECT last_insert_rowid() AS id')
      return id as number
    }
    const srcRow = await findBalanceRow(exec, m, m.from_location_id)
    const src = toBalance(srcRow, m, m.from_location_id)
    const srcNext = applyBucketDelta(src, { on_hand: -m.qty }, 'MOVE (trừ nguồn)')
    const dstRow = await findBalanceRow(exec, m, m.location_id)
    const dst = toBalance(dstRow, m, m.location_id)
    const dstNext = applyBucketDelta(dst, { on_hand: m.qty }, 'MOVE (cộng đích)')
    statements.push(movementStatement(m, src.on_hand, srcNext.on_hand, at))
    statements.push(balanceStatement(srcRow, srcNext, at))
    if (!dstRow || !srcRow || dstRow.id !== srcRow.id) statements.push(balanceStatement(dstRow, dstNext, at))
  } else if (m.type === 'REVERSAL') {
    const original = await loadMovement(exec, m.reverses_movement_id!)
    const row = await findBalanceRow(exec, m, m.location_id)
    const cur = toBalance(row, m, m.location_id)
    const next = applyReversal(cur, original)
    statements.push(movementStatement(m, cur.on_hand, next.on_hand, at))
    statements.push(balanceStatement(row, next, at))
  } else {
    const row = await findBalanceRow(exec, m, m.location_id)
    const cur = toBalance(row, m, m.location_id)
    const next = applyMovementToBalance(cur, m)
    statements.push(movementStatement(m, cur.on_hand, next.on_hand, at))
    statements.push(balanceStatement(row, next, at))
  }

  await exec.batch(statements)
  const [{ id }] = await exec.query('SELECT last_insert_rowid() AS id')
  return id as number
}

/** Đọc balances (kèm available suy ra) — cho đối chiếu/debug; UI cũ chưa dùng. */
export async function listBalances(exec: LedgerExec, sku?: string): Promise<StockBalance[]> {
  const rows = sku
    ? await exec.query('SELECT * FROM stock_balances WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY sku, location_id, lot_id', [sku])
    : await exec.query('SELECT * FROM stock_balances ORDER BY sku, location_id, lot_id')
  return rows.map((r) => {
    const b = toBalance(r, {
      warehouse_id: (r.warehouse_id as number | null) ?? null,
      location_id: (r.location_id as number | null) ?? null,
      lot_id: (r.lot_id as number | null) ?? null,
      sku: String(r.sku ?? ''), type: 'RECEIVE', qty: 1,
    }, (r.location_id as number | null) ?? null)
    return b
  })
}
