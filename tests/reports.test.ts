import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBucketDelta, applyMovementToBalance,
} from '../src/domain/ledger/apply.ts'
import {
  availableOf, emptyBuckets, type StockBalance, type StockMovement,
} from '../src/domain/ledger/types.ts'
import { buildStockCard } from '../src/domain/reports/stock-card.ts'
import { buildInOutReport, classifyMovement } from '../src/domain/reports/inout.ts'
import { buildValuation } from '../src/domain/reports/valuation.ts'
import { buildReconciliation } from '../src/domain/reports/reconciliation.ts'
import { filterMovements, summarizeByType } from '../src/domain/reports/journal.ts'

let seq = 0
const mv = (o: Partial<StockMovement> & { type: StockMovement['type'] }): StockMovement => ({
  id: ++seq, sku: 'S1', qty: 1, warehouse_id: 1, location_id: 10, lot_id: 7,
  created_at: '2026-01-01 08:00:00', actor: 'tester', ...o,
})

// ---------- Thẻ kho: số dư chạy khớp balances dựng bằng apply của ledger ----------
test('stock card: closing khớp tổng balances dựng độc lập bằng applyMovementToBalance', () => {
  seq = 0
  const A = 10; const B = 11
  const movements: StockMovement[] = [
    mv({ type: 'RECEIVE', qty: 10, location_id: A, into_inspect: true, doc_type: 'RECEIPT', doc_id: 1 }),
    mv({ type: 'DAMAGE', qty: 2, location_id: A, from_inspect: true, reason_code: 'DAMAGED' }),
    mv({ type: 'PUTAWAY', qty: 8, location_id: B, from_location_id: A }),
    mv({ type: 'ALLOCATE', qty: 5, location_id: B }),
    mv({ type: 'PICK', qty: 5, location_id: B }),
    mv({ type: 'FREEZE', qty: 1, location_id: B, reason_code: 'QUALITY_HOLD' }),
    mv({ type: 'RETURN_IN', qty: 3, location_id: A, into_inspect: true, doc_type: 'RETURN' }),
    mv({ type: 'ADJUST_OUT', qty: 1, location_id: B, reason_code: 'COUNT_VARIANCE' }),
    mv({ type: 'MOVE', qty: 1, location_id: A, from_location_id: B }),
    mv({ type: 'UNFREEZE', qty: 1, location_id: B }),
  ]
  // Dựng balances theo từng vị trí bằng đúng tầng áp của ledger (đường độc lập
  // với lotBucketDelta): PUTAWAY/MOVE khác vị trí áp hai phía như recordMovement.
  const balances = new Map<number, StockBalance>()
  const balAt = (loc: number): StockBalance => {
    let b = balances.get(loc)
    if (!b) {
      b = { warehouse_id: 1, location_id: loc, lot_id: 7, sku: 'S1', ...emptyBuckets(), available: 0 }
      balances.set(loc, b)
    }
    return b
  }
  const set = (loc: number, b: StockBalance) => balances.set(loc, b)
  for (const m of movements) {
    const cross = (m.type === 'PUTAWAY' || m.type === 'MOVE')
      && m.from_location_id != null && m.location_id != null && m.from_location_id !== m.location_id
    if (cross && m.type === 'PUTAWAY') {
      set(m.from_location_id!, applyBucketDelta(balAt(m.from_location_id!), { on_hand: -m.qty, inspect: -m.qty }))
      set(m.location_id!, applyBucketDelta(balAt(m.location_id!), { on_hand: m.qty }))
    } else if (cross && m.type === 'MOVE') {
      set(m.from_location_id!, applyBucketDelta(balAt(m.from_location_id!), { on_hand: -m.qty }))
      set(m.location_id!, applyBucketDelta(balAt(m.location_id!), { on_hand: m.qty }))
    } else {
      set(m.location_id!, applyMovementToBalance(balAt(m.location_id!), m))
    }
  }
  const sum = { ...emptyBuckets() }
  for (const b of balances.values()) {
    sum.on_hand += b.on_hand; sum.allocated += b.allocated; sum.hold += b.hold
    sum.damaged += b.damaged; sum.inspect += b.inspect; sum.in_transit += b.in_transit
  }
  const card = buildStockCard(movements)
  assert.equal(card.lines.length, movements.length)
  assert.deepEqual(card.closing, sum)
  assert.equal(card.closing.on_hand, 7)
  assert.equal(card.closing.inspect, 3)
  assert.equal(card.closing.damaged, 2)
  assert.equal(card.closing_available, availableOf(sum))
  // Sau dòng PUTAWAY (dòng 3): on_hand cấp lô vẫn 10 (chỉ đổi vị trí + rời inspect).
  assert.equal(card.lines[2].balance_after.on_hand, 10)
  assert.equal(card.lines[2].balance_after.inspect, 0)
  // Sau PICK: on_hand 5 (10 - 5), allocated đã tiêu thụ hết.
  assert.equal(card.lines[4].balance_after.on_hand, 5)
  assert.equal(card.lines[4].balance_after.allocated, 0)
})

test('stock card: REVERSAL đảo đúng hiệu ứng movement gốc', () => {
  seq = 100
  const movements: StockMovement[] = [
    mv({ type: 'RECEIVE', qty: 6 }),
    mv({ type: 'PICK', qty: 6 }),
  ]
  const pickId = movements[1].id!
  movements.push(mv({ type: 'REVERSAL', qty: 6, reverses_movement_id: pickId }))
  const card = buildStockCard(movements)
  assert.equal(card.closing.on_hand, 6) // đảo PICK -> hàng quay lại
})

// ---------- Nhập–Xuất–Tồn ----------
test('inout: phân loại đúng, movement trung tính không lọt nhập/xuất, closing đúng công thức', () => {
  seq = 200
  const movements: StockMovement[] = [
    mv({ type: 'RECEIVE', qty: 10, created_at: '2026-01-01 08:00:00' }),
    mv({ type: 'ALLOCATE', qty: 4, created_at: '2026-01-01 09:00:00' }),
    mv({ type: 'FREEZE', qty: 1, created_at: '2026-01-01 10:00:00' }),
    mv({ type: 'DAMAGE', qty: 1, created_at: '2026-01-01 11:00:00', reason_code: 'DAMAGED' }),
    mv({ type: 'PICK', qty: 4, created_at: '2026-01-05 08:00:00' }),
    mv({ type: 'ADJUST_IN', qty: 2, created_at: '2026-01-05 09:00:00', reason_code: 'COUNT_VARIANCE' }),
    mv({ type: 'MOVE', qty: 2, created_at: '2026-01-05 10:00:00', from_location_id: 11 }),
    mv({ type: 'WRITE_OFF', qty: 1, created_at: '2026-01-05 11:00:00', reason_code: 'WRITE_OFF' }),
    mv({ type: 'TRANSFER_OUT', qty: 1, created_at: '2026-01-05 12:00:00' }),
    mv({ type: 'RETURN_IN', qty: 3, created_at: '2026-01-10 08:00:00' }),
    mv({ type: 'TRANSFER_IN', qty: 1, created_at: '2026-01-10 09:00:00', from_warehouse_id: 2 }),
    mv({ type: 'RECEIVE', qty: 5, sku: 'S2', created_at: '2026-01-05 08:00:00', warehouse_id: 2 }),
  ]
  const rows = buildInOutReport(movements, { from: '2026-01-03', to: '2026-01-07' })
  const s1 = rows.find((r) => r.sku === 'S1')!
  assert.deepEqual(
    { opening: s1.opening, in_qty: s1.in_qty, out_qty: s1.out_qty, closing: s1.closing },
    { opening: 10, in_qty: 2, out_qty: 6, closing: 6 },
  )
  // Kỳ phủ toàn bộ: closing = tổng hiệu ứng on_hand = balances cuối kỳ.
  const full = buildInOutReport(movements, { from: '2026-01-01', to: '2026-01-31' })
  const s1Full = full.find((r) => r.sku === 'S1')!
  assert.equal(s1Full.closing, 10) // 10 +2 +3 +1 −4 −1 −1
  assert.equal(s1Full.opening, 0)
  // Lọc theo kho: RECEIVE kho 2 của S2 không lọt vào báo cáo kho 1.
  const wh1 = buildInOutReport(movements, { from: '2026-01-01', to: '2026-01-31', warehouse_id: 1 })
  assert.equal(wh1.find((r) => r.sku === 'S2'), undefined)
  const wh2 = buildInOutReport(movements, { from: '2026-01-01', to: '2026-01-31', warehouse_id: 2 })
  assert.equal(wh2.find((r) => r.sku === 'S2')!.closing, 5)
})

test('inout: classifyMovement — DAMAGE/MOVE trung tính, REVERSAL ngược chiều gốc', () => {
  seq = 300
  const pick = mv({ type: 'PICK', qty: 2 })
  assert.equal(classifyMovement(mv({ type: 'DAMAGE', qty: 1, reason_code: 'DAMAGED' })), 'NEUTRAL')
  assert.equal(classifyMovement(mv({ type: 'MOVE', qty: 1 })), 'NEUTRAL')
  assert.equal(classifyMovement(mv({ type: 'RECEIVE', qty: 1 })), 'IN')
  assert.equal(classifyMovement(pick), 'OUT')
  const rev = mv({ type: 'REVERSAL', qty: 2, reverses_movement_id: pick.id })
  assert.equal(classifyMovement(rev, (id) => (id === pick.id ? pick : undefined)), 'IN')
})

// ---------- Định giá ----------
test('valuation: lô có giá/không giá tách nhóm, damaged tách cột, lô hết tồn bị loại', () => {
  const rep = buildValuation([
    { lot_id: 1, sku: 'A', purchase_price: 100, on_hand: 10, damaged: 2 },
    { lot_id: 2, sku: 'A', purchase_price: null, on_hand: 5, damaged: 0 },
    { lot_id: 3, sku: 'B', purchase_price: 50, on_hand: 0, damaged: 0 },
    { lot_id: 4, sku: 'B', purchase_price: 50, on_hand: 3, damaged: 3 },
  ])
  assert.equal(rep.rows.length, 3) // lô 3 hết tồn -> loại
  const l1 = rep.rows.find((r) => r.lot_id === 1)!
  assert.deepEqual(
    { v: l1.qty_valued, val: l1.value, dv: l1.damaged_value },
    { v: 8, val: 800, dv: 200 },
  )
  const l4 = rep.rows.find((r) => r.lot_id === 4)!
  assert.equal(l4.qty_valued, 0)
  assert.equal(l4.value, 0)
  assert.equal(l4.damaged_value, 150)
  assert.equal(rep.total_value, 800)
  assert.equal(rep.total_damaged_value, 350)
  assert.deepEqual(rep.unpriced, { lot_count: 1, qty_valued: 5, qty_damaged: 0 })
  const byA = rep.by_sku.find((s) => s.sku === 'A')!
  assert.equal(byA.value, 800)
  assert.equal(byA.lot_count, 1) // chỉ lô có giá mới vào tổng theo SKU
})

// ---------- Đối chiếu ----------
test('reconciliation: đủ 4 trạng thái MATCH/DIFF/ONLY_LEDGER/ONLY_FILE', () => {
  const rows = buildReconciliation(
    new Map([['A', 10], ['B', 5], ['C', 3]]),
    new Map([['A', 10], ['B', 7], ['D', 2]]),
  )
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]))
  assert.equal(by.A.status, 'MATCH')
  assert.equal(by.B.status, 'DIFF')
  assert.equal(by.B.diff, -2)
  assert.equal(by.C.status, 'ONLY_LEDGER')
  assert.equal(by.C.file_qty, 0)
  assert.equal(by.D.status, 'ONLY_FILE')
  assert.equal(by.D.ledger_qty, 0)
})

// ---------- Nhật ký ----------
test('journal: lọc theo kỳ/loại/người và tổng hợp theo loại', () => {
  seq = 400
  const movements: StockMovement[] = [
    mv({ type: 'RECEIVE', qty: 5, actor: 'an', created_at: '2026-02-01 08:00:00' }),
    mv({ type: 'PICK', qty: 2, actor: 'binh', created_at: '2026-02-02 08:00:00' }),
    mv({ type: 'PICK', qty: 1, actor: 'an', created_at: '2026-02-03 08:00:00' }),
  ]
  assert.equal(filterMovements(movements, { type: 'PICK' }).length, 2)
  assert.equal(filterMovements(movements, { actor: 'an' }).length, 2)
  assert.equal(filterMovements(movements, { from: '2026-02-02', to: '2026-02-02' }).length, 1)
  const sum = summarizeByType(movements)
  assert.deepEqual(sum.find((s) => s.type === 'PICK'), { type: 'PICK', count: 2, qty: 3 })
})
