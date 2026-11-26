import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMovementToBalance, validateMovement } from '../src/domain/ledger/apply.ts'
import { rebuildBalances } from '../src/domain/ledger/balance.ts'
import {
  availableOf, emptyBuckets, type StockBalance, type StockMovement,
} from '../src/domain/ledger/types.ts'
import {
  allCounted, buildCountTasks, computeVariance, planCountAdjustments,
  type BalanceForCount,
} from '../src/domain/ops/cycle-count.ts'
import { planFreeze, planUnfreeze, type FreezeTarget } from '../src/domain/ops/freeze.ts'
import {
  assertTransferTransition, movableQty, planMove, planTransferIn, planTransferOut,
  type MoveSource, type TransferLineState,
} from '../src/domain/ops/transfer.ts'
import {
  computeSuggestions, groupBySupplier, suggestionKey,
  type PolicyForSuggest,
} from '../src/domain/ops/replenishment.ts'
import { daysUntil, scanAlerts } from '../src/domain/ops/alerts.ts'
import { candidateAvailable } from '../src/domain/outbound/allocation.ts'

const bal = (o: Partial<StockBalance> = {}): StockBalance => ({
  warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1',
  ...emptyBuckets(), available: 0, ...o,
})

// ---------- Cycle count ----------
const countBalances: BalanceForCount[] = [
  { warehouse_id: 1, location_id: 10, zone_id: 100, lot_id: 5, sku: 'S1', on_hand: 8, hold: 2, inspect: 0 },
  { warehouse_id: 1, location_id: 10, zone_id: 100, lot_id: 6, sku: 'S2', on_hand: 0, hold: 0, inspect: 3 },
  { warehouse_id: 1, location_id: 11, zone_id: 100, lot_id: 7, sku: 'S1', on_hand: 4, hold: 0, inspect: 0 },
  { warehouse_id: 1, location_id: 12, zone_id: 200, lot_id: 8, sku: 'S3', on_hand: 0, hold: 1, inspect: 0 },
]

test('buildCountTasks: lọc theo LOCATION, chỉ lấy on_hand>0 hoặc hold>0, expected = on_hand', () => {
  const tasks = buildCountTasks(countBalances, { type: 'LOCATION', location_id: 10 })
  // Dòng S2 (on_hand 0, hold 0, chỉ inspect) bị loại; hold/inspect snapshot riêng.
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].sku, 'S1')
  assert.equal(tasks[0].expected_qty, 8)
  assert.equal(tasks[0].hold_qty, 2)
  assert.equal(tasks[0].inspect_qty, 0)
})

test('buildCountTasks: lọc theo ZONE và theo SKU', () => {
  const byZone = buildCountTasks(countBalances, { type: 'ZONE', zone_id: 100 })
  assert.deepEqual(byZone.map((t) => t.lot_id), [5, 7])
  const bySku = buildCountTasks(countBalances, { type: 'SKU', sku: 's1' })
  assert.deepEqual(bySku.map((t) => t.lot_id), [5, 7])
  // S3 chỉ còn hold vẫn được kiểm (hàng đóng băng phải đếm được).
  const zone200 = buildCountTasks(countBalances, { type: 'ZONE', zone_id: 200 })
  assert.equal(zone200.length, 1)
  assert.equal(zone200[0].expected_qty, 0)
})

test('computeVariance + planCountAdjustments: đúng số -> không movement; lệch -> ADJUST có reason', () => {
  assert.equal(computeVariance(8, 8), 0)
  assert.equal(computeVariance(8, 6), -2)
  assert.equal(computeVariance(8, 9), 1)
  const tasks = [
    { id: 1, warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1', expected_qty: 8, counted_qty: 8 },
    { id: 2, warehouse_id: 1, location_id: 10, lot_id: 6, sku: 'S2', expected_qty: 5, counted_qty: 3 },
    { id: 3, warehouse_id: 1, location_id: 11, lot_id: 7, sku: 'S3', expected_qty: 2, counted_qty: 4 },
  ]
  const mvs = planCountAdjustments(tasks, { count_id: 9, actor: 'kiem1' })
  assert.equal(mvs.length, 2)
  assert.equal(mvs[0].type, 'ADJUST_OUT')
  assert.equal(mvs[0].qty, 2)
  assert.equal(mvs[1].type, 'ADJUST_IN')
  assert.equal(mvs[1].qty, 2)
  for (const m of mvs) {
    assert.equal(m.reason_code, 'COUNT_VARIANCE')
    assert.equal(m.doc_type, 'COUNT')
    assert.equal(m.doc_id, 9)
    validateMovement(m) // reason hợp lệ ở tầng ledger -> không throw
  }
  assert.equal(allCounted(tasks), true)
})

test('planCountAdjustments: còn dòng chưa đếm -> chặn; ADJUST thiếu reason bị ledger chặn', () => {
  const tasks = [
    { id: 1, warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1', expected_qty: 8, counted_qty: null },
  ]
  assert.throws(() => planCountAdjustments(tasks, { count_id: 1 }), /chưa nhập số đếm/)
  assert.equal(allCounted(tasks), false)
  assert.throws(
    () => validateMovement({ type: 'ADJUST_OUT', sku: 'S1', qty: 1, warehouse_id: 1, location_id: 10, lot_id: 5 }),
    /bắt buộc có lý do/,
  )
})

// ---------- Freeze ----------
const freezeTarget = (o: Partial<FreezeTarget> = {}): FreezeTarget => ({
  warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1',
  on_hand: 10, allocated: 2, hold: 0, damaged: 0, inspect: 0, in_transit: 0, ...o,
})

test('planFreeze: hợp lệ -> movement FREEZE kèm reason; hold trừ vào khả dụng phân bổ', () => {
  const r = planFreeze(freezeTarget(), { qty: 3, reason_code: 'QUALITY_HOLD' })
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.movement.type, 'FREEZE')
  assert.equal(r.movement.reason_code, 'QUALITY_HOLD')
  // Áp vào balance rồi kiểm tra ứng viên allocation: available 10-2-3 = 5.
  const after = applyMovementToBalance(bal({ on_hand: 10, allocated: 2 }), r.movement)
  assert.equal(after.hold, 3)
  assert.equal(availableOf(after), 5)
  assert.equal(candidateAvailable({
    lot_id: 5, location_id: 10, sku: 'S1', lot_status: 'AVAILABLE', loc_type: 'PICKABLE',
    location_active: 1, expiry_date: null, ...after,
  }), 5)
})

test('planFreeze: vượt khả dụng / thiếu lý do / lý do ngoài danh mục -> lỗi', () => {
  // Khả dụng = 10 - 2 allocated = 8.
  assert.equal(planFreeze(freezeTarget(), { qty: 9, reason_code: 'QUALITY_HOLD' }).ok, false)
  assert.equal(planFreeze(freezeTarget(), { qty: 1 }).ok, false)
  assert.equal(planFreeze(freezeTarget(), { qty: 1, reason_code: 'KHONG_CO' }).ok, false)
  assert.equal(planFreeze(freezeTarget(), { qty: 0, reason_code: 'DAMAGE_SUSPECT' }).ok, false)
})

test('planUnfreeze: vượt số đang băng -> lỗi; đúng -> movement UNFREEZE', () => {
  const t = freezeTarget({ hold: 3 })
  assert.equal(planUnfreeze(t, { qty: 4 }).ok, false)
  const r = planUnfreeze(t, { qty: 3 })
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.movement.type, 'UNFREEZE')
})

// ---------- Transfer ----------
const moveSource = (o: Partial<MoveSource> = {}): MoveSource => ({
  warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1',
  on_hand: 10, allocated: 3, hold: 2, damaged: 0, inspect: 0, in_transit: 0, ...o,
})

test('planMove: phần di chuyển được trừ allocated + hold; vượt -> lỗi; trùng vị trí -> lỗi', () => {
  assert.equal(movableQty(moveSource()), 5)
  const ok = planMove(moveSource(), { qty: 5, to_location_id: 11 })
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.movement.type, 'MOVE')
    assert.equal(ok.movement.from_location_id, 10)
    assert.equal(ok.movement.location_id, 11)
  }
  assert.equal(planMove(moveSource(), { qty: 6, to_location_id: 11 }).ok, false)
  assert.equal(planMove(moveSource(), { qty: 1, to_location_id: 10 }).ok, false)
  // inspect/damaged cũng không di chuyển được
  assert.equal(movableQty(moveSource({ inspect: 2, damaged: 1, allocated: 0, hold: 0 })), 7)
})

test('transfer order: transitions + planTransferOut kiểm khả dụng, planTransferIn hai phía', () => {
  assert.throws(() => assertTransferTransition('DRAFT', 'DONE'), /Không chuyển được/)
  assert.throws(() => assertTransferTransition('DONE', 'IN_TRANSIT'), /Không chuyển được/)
  assert.doesNotThrow(() => assertTransferTransition('DRAFT', 'IN_TRANSIT'))
  assert.doesNotThrow(() => assertTransferTransition('IN_TRANSIT', 'DONE'))
  assert.doesNotThrow(() => assertTransferTransition('DRAFT', 'CANCELLED'))

  const lines: TransferLineState[] = [
    { id: 1, sku: 'S1', lot_id: 5, from_location_id: 10, to_location_id: 20, qty: 4 },
  ]
  const outs = planTransferOut(lines, [moveSource()], { transfer_id: 3, from_warehouse_id: 1 })
  assert.equal(outs.length, 1)
  assert.equal(outs[0].type, 'TRANSFER_OUT')
  assert.throws(
    () => planTransferOut([{ ...lines[0], qty: 6 }], [moveSource()], { transfer_id: 3, from_warehouse_id: 1 }),
    /vượt phần di chuyển được/,
  )
  const ins = planTransferIn(lines, { transfer_id: 3, from_warehouse_id: 1, to_warehouse_id: 2 })
  assert.equal(ins[0].type, 'TRANSFER_IN')
  assert.equal(ins[0].warehouse_id, 2)
  assert.equal(ins[0].from_location_id, 10)
  assert.equal(ins[0].from_warehouse_id, 1)
})

test('rebuildBalances: TRANSFER_OUT -> TRANSFER_IN hai phía chuyển in_transit sang kho đích', () => {
  const mvs: StockMovement[] = [
    { type: 'RECEIVE', warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1', qty: 10 },
    { type: 'TRANSFER_OUT', warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1', qty: 4 },
    {
      type: 'TRANSFER_IN', warehouse_id: 2, location_id: 20, from_location_id: 10,
      from_warehouse_id: 1, lot_id: 5, sku: 'S1', qty: 4,
    },
  ]
  const map = rebuildBalances(mvs)
  const src = [...map.values()].find((b) => b.warehouse_id === 1 && b.location_id === 10)!
  const dst = [...map.values()].find((b) => b.warehouse_id === 2 && b.location_id === 20)!
  assert.equal(src.on_hand, 6)
  assert.equal(src.in_transit, 0)
  assert.equal(dst.on_hand, 4)
  assert.equal(dst.available, 4)
})

// ---------- Replenishment ----------
const policy = (o: Partial<PolicyForSuggest> = {}): PolicyForSuggest => ({
  sku: 'S1', warehouse_id: 1, min_qty: 5, max_qty: 20, reorder_point: null, reorder_qty: null, ...o,
})

test('computeSuggestions: available < min -> suggested = max - available - on_order', () => {
  const avail = new Map([[suggestionKey(1, 'S1'), 6]])
  const onOrder = new Map([[suggestionKey(1, 'S1'), 4]])
  // min 5 nhưng available 6 chưa chạm min... dùng reorder_point 8 để kích hoạt.
  const s = computeSuggestions([policy({ reorder_point: 8 })], avail, onOrder)
  assert.equal(s.length, 1)
  assert.equal(s[0].suggested_qty, 20 - 6 - 4)
  assert.equal(s[0].on_order, 4)
})

test('computeSuggestions: chưa chạm ngưỡng -> không gợi ý; hàng đang về đủ -> bỏ qua', () => {
  const avail = new Map([[suggestionKey(1, 'S1'), 6]])
  assert.equal(computeSuggestions([policy()], avail, new Map()).length, 0) // 6 >= min 5
  const low = new Map([[suggestionKey(1, 'S1'), 3]])
  // suggested = 20 - 3 - 17 = 0 -> bỏ qua.
  assert.equal(computeSuggestions([policy()], low, new Map([[suggestionKey(1, 'S1'), 17]])).length, 0)
  // Không có ngưỡng nào -> không gợi ý.
  assert.equal(computeSuggestions([policy({ min_qty: null })], low, new Map()).length, 0)
  // Đúng công thức khi thiếu thật: 20 - 3 - 2 = 15.
  const s = computeSuggestions([policy()], low, new Map([[suggestionKey(1, 'S1'), 2]]))
  assert.equal(s[0].suggested_qty, 15)
})

test('groupBySupplier: gom theo NCC mặc định, nhóm chưa rõ NCC xếp cuối', () => {
  const suggestions = computeSuggestions(
    [policy(), policy({ sku: 'S2' }), policy({ sku: 'S3' })],
    new Map([
      [suggestionKey(1, 'S1'), 1], [suggestionKey(1, 'S2'), 1], [suggestionKey(1, 'S3'), 1],
    ]),
    new Map(),
  )
  assert.equal(suggestions.length, 3)
  const groups = groupBySupplier(suggestions, new Map([
    ['S1', { supplier_id: 7, supplier_name: 'NCC A' }],
    ['S2', { supplier_id: 7, supplier_name: 'NCC A' }],
    ['S3', null],
  ]))
  assert.equal(groups.length, 2)
  assert.equal(groups[0].supplier_id, 7)
  assert.equal(groups[0].lines.length, 2)
  assert.equal(groups[1].supplier_id, null)
  assert.equal(groups[1].supplier_name, 'Chưa rõ NCC')
})

// ---------- Alerts ----------
const TODAY = '2026-01-15'
const alertInput = (over: Partial<Parameters<typeof scanAlerts>[0]> = {}) => ({
  lots: [
    { lot_id: 1, sku: 'A', expiry_date: '2026-01-10' }, // đã hết hạn 5 ngày
    { lot_id: 2, sku: 'B', expiry_date: '2026-01-20' }, // còn 5 ngày -> EXPIRY_7
    { lot_id: 3, sku: 'C', expiry_date: '2026-01-25' }, // còn 10 ngày -> EXPIRY_15
    { lot_id: 4, sku: 'D', expiry_date: '2026-02-04' }, // còn 20 ngày -> EXPIRY_30
    { lot_id: 5, sku: 'E', expiry_date: '2026-03-16' }, // còn 60 ngày -> không cảnh báo
    { lot_id: 6, sku: 'F', expiry_date: '2026-01-01' }, // hết hạn nhưng hết tồn -> không cảnh báo
  ],
  balances: [
    { warehouse_id: 1, location_id: 10, lot_id: 1, sku: 'A', on_hand: 5, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 2, sku: 'B', on_hand: 5, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 3, sku: 'C', on_hand: 5, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 4, sku: 'D', on_hand: 5, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'E', on_hand: 5, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 6, sku: 'F', on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 11, lot_id: 7, sku: 'G', on_hand: 9, allocated: 0, hold: 2, damaged: 0, inspect: 3, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 8, sku: 'LOW', on_hand: 3, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
    { warehouse_id: 1, location_id: 10, lot_id: 9, sku: 'OUT', on_hand: 2, allocated: 2, hold: 0, damaged: 0, inspect: 0, in_transit: 0 },
  ],
  policies: [
    { sku: 'LOW', warehouse_id: 1, min_qty: 5, reorder_point: null },
    { sku: 'OUT', warehouse_id: 1, min_qty: 5, reorder_point: null },
    { sku: 'A', warehouse_id: 1, min_qty: 1, reorder_point: null },
  ],
  today: TODAY,
  ...over,
})

test('scanAlerts: các mốc hết hạn 30/15/7/đã hết hạn đúng severity, lô hết tồn không báo', () => {
  const alerts = scanAlerts(alertInput())
  const byType = new Map(alerts.map((a) => [a.type, a]))
  assert.equal(byType.get('EXPIRY_EXPIRED')?.severity, 'CRITICAL')
  assert.equal(byType.get('EXPIRY_EXPIRED')?.lot_id, 1)
  assert.equal(byType.get('EXPIRY_7')?.severity, 'CRITICAL')
  assert.equal(byType.get('EXPIRY_7')?.lot_id, 2)
  assert.equal(byType.get('EXPIRY_15')?.severity, 'WARN')
  assert.equal(byType.get('EXPIRY_15')?.lot_id, 3)
  assert.equal(byType.get('EXPIRY_30')?.severity, 'INFO')
  assert.equal(byType.get('EXPIRY_30')?.lot_id, 4)
  assert.ok(!alerts.some((a) => a.lot_id === 5), 'lô còn 60 ngày không cảnh báo')
  assert.ok(!alerts.some((a) => a.lot_id === 6), 'lô hết tồn không cảnh báo hết hạn')
})

test('scanAlerts: tồn thấp WARN, hết hàng CRITICAL, chờ QC + đóng băng, alert_key ổn định chống trùng', () => {
  const alerts = scanAlerts(alertInput())
  const low = alerts.find((a) => a.type === 'LOW_STOCK')
  assert.equal(low?.sku, 'LOW')
  assert.equal(low?.severity, 'WARN')
  const out = alerts.find((a) => a.type === 'OUT_OF_STOCK')
  assert.equal(out?.sku, 'OUT')
  assert.equal(out?.severity, 'CRITICAL')
  assert.ok(alerts.some((a) => a.type === 'PENDING_QC' && a.sku === 'G'))
  assert.ok(alerts.some((a) => a.type === 'FROZEN_STOCK' && a.sku === 'G'))
  // Quét lại cùng dữ liệu -> cùng tập alert_key (upsert không sinh trùng).
  const again = scanAlerts(alertInput())
  assert.deepEqual(
    alerts.map((a) => a.alert_key).sort(),
    again.map((a) => a.alert_key).sort(),
  )
  assert.equal(new Set(alerts.map((a) => a.alert_key)).size, alerts.length)
  assert.equal(daysUntil('2026-01-15', '2026-01-20'), 5)
  assert.equal(daysUntil('2026-01-15', '2026-01-10'), -5)
})
