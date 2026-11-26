// GĐ1 — inbound: PO transitions/rollup, receiving shortage/more/damage,
// QC partial, putaway suggestion. Logic thuần ở src/domain/inbound + ledger.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertPoTransition, canTransitionPo, isReceivable, poStatusAfterReceiving,
} from '../src/domain/inbound/purchase-order.ts'
import { planReceiving } from '../src/domain/inbound/receiving.ts'
import { lotStatusAfter, planQc, qtyAwaitingPutaway, qtyPendingQc } from '../src/domain/inbound/qc.ts'
import { planPutaway, suggestPutawayLocation, type PutawayLocation } from '../src/domain/inbound/putaway.ts'
import { applyMovementToBalance, type BalanceBuckets } from '../src/domain/ledger/apply.ts'
import type { StockMovement } from '../src/domain/ledger/types.ts'
import { can as hasPermission } from '../src/domain/permissions/guard.ts'

const LOC: PutawayLocation[] = [
  { id: 1, warehouse_id: 1, zone_id: 1, code: 'NHAN-01', loc_type: 'RECEIVING', pick_sequence: 1, active: 1 },
  { id: 2, warehouse_id: 1, zone_id: 2, code: 'A01-01', loc_type: 'PICKABLE', pick_sequence: 101, active: 1 },
  { id: 3, warehouse_id: 1, zone_id: 2, code: 'A01-02', loc_type: 'PICKABLE', pick_sequence: 102, active: 1 },
  { id: 4, warehouse_id: 1, zone_id: 3, code: 'B01-01', loc_type: 'PICKABLE', pick_sequence: 201, active: 1 },
  { id: 5, warehouse_id: 1, zone_id: 4, code: 'BULK-01', loc_type: 'BULK', pick_sequence: 900, active: 1 },
  { id: 6, warehouse_id: 1, zone_id: 5, code: 'HONG-01', loc_type: 'DAMAGE', pick_sequence: 950, active: 1 },
  { id: 7, warehouse_id: 1, zone_id: 2, code: 'A01-03', loc_type: 'PICKABLE', pick_sequence: 103, active: 0 },
]

describe('PO transitions', () => {
  it('đúng luồng DRAFT->SENT->PARTIAL->RECEIVED->CLOSED, CANCELLED từ DRAFT/SENT', () => {
    assert.equal(canTransitionPo('DRAFT', 'SENT'), true)
    assert.equal(canTransitionPo('SENT', 'PARTIAL'), true)
    assert.equal(canTransitionPo('PARTIAL', 'RECEIVED'), true)
    assert.equal(canTransitionPo('RECEIVED', 'CLOSED'), true)
    assert.equal(canTransitionPo('DRAFT', 'CANCELLED'), true)
    assert.equal(canTransitionPo('SENT', 'CANCELLED'), true)
    assert.equal(canTransitionPo('PARTIAL', 'CANCELLED'), false)
    assert.equal(canTransitionPo('DRAFT', 'RECEIVED'), false)
    assert.equal(canTransitionPo('CLOSED', 'SENT'), false)
    assert.throws(() => assertPoTransition('DRAFT', 'RECEIVED'), /Không chuyển được PO/)
  })

  it('rollup: nhận một phần -> PARTIAL, nhận đủ mọi dòng -> RECEIVED', () => {
    assert.equal(poStatusAfterReceiving([{ qty_ordered: 10, qty_received: 4 }]), 'PARTIAL')
    assert.equal(poStatusAfterReceiving([{ qty_ordered: 10, qty_received: 10 }, { qty_ordered: 5, qty_received: 3 }]), 'PARTIAL')
    assert.equal(poStatusAfterReceiving([{ qty_ordered: 10, qty_received: 10 }, { qty_ordered: 5, qty_received: 5 }]), 'RECEIVED')
    // Nhận thừa cũng coi như đủ.
    assert.equal(poStatusAfterReceiving([{ qty_ordered: 10, qty_received: 12 }]), 'RECEIVED')
  })

  it('chỉ SENT/PARTIAL mới nhận được hàng', () => {
    assert.equal(isReceivable('SENT'), true)
    assert.equal(isReceivable('PARTIAL'), true)
    assert.equal(isReceivable('DRAFT'), false)
    assert.equal(isReceivable('RECEIVED'), false)
  })
})

describe('receiving plan', () => {
  const lines = [
    { id: 1, sku: 'A', qty_ordered: 10, qty_received: 0 },
    { id: 2, sku: 'B', qty_ordered: 5, qty_received: 2 },
  ]
  const ctx = { po_id: 9, po_status: 'SENT' as const, warehouse_id: 1, receiving_location_id: 1, actor: 'tester' }

  it('tính shortage/more/good/damaged và sinh movement RECEIVE into_inspect + trạng thái PO mới', () => {
    const r = planReceiving(lines, [
      { po_line_id: 1, qty_received: 8, qty_damaged: 1, lot_id: 101, batch_no: 'L1' },
      { po_line_id: 2, qty_received: 5, qty_damaged: 0, lot_id: 102 },
    ], ctx)
    assert.equal(r.ok, true)
    if (!r.ok) return
    const [a, b] = r.plan.lines
    assert.deepEqual([a.qty_expected, a.qty_received, a.qty_good, a.qty_damaged, a.qty_shortage, a.qty_more], [10, 8, 7, 1, 2, 0])
    assert.deepEqual([b.qty_expected, b.qty_received, b.qty_shortage, b.qty_more], [3, 5, 0, 2])
    assert.equal(r.plan.next_po_status, 'PARTIAL') // dòng A còn thiếu 2
    assert.equal(r.plan.movements.length, 2)
    const m = r.plan.movements[0]
    assert.equal(m.type, 'RECEIVE')
    assert.equal(m.into_inspect, true)
    assert.equal(m.location_id, 1)
    assert.equal(m.lot_id, 101)
    assert.equal(m.qty, 8)
  })

  it('nhận đủ mọi dòng -> PO RECEIVED', () => {
    const r = planReceiving(lines, [
      { po_line_id: 1, qty_received: 10, lot_id: 101 },
      { po_line_id: 2, qty_received: 3, lot_id: 102 },
    ], ctx)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.plan.next_po_status, 'RECEIVED')
  })

  it('chặn: PO chưa gửi, hỏng > nhận, dòng không thuộc PO, nhập trùng dòng', () => {
    assert.equal(planReceiving(lines, [{ po_line_id: 1, qty_received: 1 }], { ...ctx, po_status: 'DRAFT' }).ok, false)
    assert.equal(planReceiving(lines, [{ po_line_id: 1, qty_received: 2, qty_damaged: 3 }], ctx).ok, false)
    assert.equal(planReceiving(lines, [{ po_line_id: 99, qty_received: 1 }], ctx).ok, false)
    assert.equal(planReceiving(lines, [
      { po_line_id: 1, qty_received: 1 }, { po_line_id: 1, qty_received: 1 },
    ], ctx).ok, false)
    assert.equal(planReceiving(lines, [{ po_line_id: 1, qty_received: 0 }], ctx).ok, false)
  })
})

describe('QC plan + luồng xô tồn qua ledger', () => {
  const line = {
    id: 5, receipt_id: 3, sku: 'A', lot_id: 101,
    qty_received: 10, qty_qc_pass: 0, qty_qc_fail: 0, qty_putaway: 0,
  }
  const ctx = { warehouse_id: 1, receiving_location_id: 1, actor: 'tester' }

  it('QC partial: pass 6 / fail 4 -> movement DAMAGE from_inspect, qc_status PARTIAL, lot DAMAGED', () => {
    const r = planQc(line, { qty_pass: 6, qty_fail: 4, reason_code: 'DAMAGED' }, ctx)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.plan.qc_status, 'PARTIAL')
    assert.equal(r.plan.qc_complete, true)
    assert.equal(r.plan.movements.length, 1)
    const m = r.plan.movements[0]
    assert.equal(m.type, 'DAMAGE')
    assert.equal(m.from_inspect, true)
    assert.equal(m.qty, 4)
    assert.equal(m.reason_code, 'DAMAGED')
    assert.equal(qtyAwaitingPutaway({ ...line, qty_qc_pass: 6, qty_qc_fail: 4 }), 6)
    // Lô còn phần chờ cất -> vẫn INSPECT; cất xong phần đạt -> AVAILABLE.
    assert.equal(lotStatusAfter({ ...line, qty_qc_pass: 6, qty_qc_fail: 4 }), 'INSPECT')
    assert.equal(lotStatusAfter({ ...line, qty_qc_pass: 6, qty_qc_fail: 4, qty_putaway: 6 }), 'AVAILABLE')
    // Hỏng toàn bộ -> DAMAGED.
    assert.equal(lotStatusAfter({ ...line, qty_qc_pass: 0, qty_qc_fail: 10 }), 'DAMAGED')
  })

  it('QC fail bắt buộc lý do; không vượt số chờ QC; pass hết -> lot AVAILABLE', () => {
    assert.equal(planQc(line, { qty_pass: 0, qty_fail: 2 }, ctx).ok, false)
    assert.equal(planQc(line, { qty_pass: 9, qty_fail: 2, reason_code: 'DAMAGED' }, ctx).ok, false)
    const r = planQc(line, { qty_pass: 10, qty_fail: 0 }, ctx)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.plan.qc_status, 'PASS')
      assert.equal(r.plan.movements.length, 0)
      // Đạt hết nhưng chưa cất -> INSPECT; cất xong -> AVAILABLE.
      assert.equal(lotStatusAfter({ ...line, qty_qc_pass: 10 }), 'INSPECT')
      assert.equal(lotStatusAfter({ ...line, qty_qc_pass: 10, qty_putaway: 10 }), 'AVAILABLE')
    }
    assert.equal(qtyPendingQc(line), 10)
  })

  it('xô tồn: RECEIVE into_inspect -> DAMAGE from_inspect -> PUTAWAY sang on_hand đích', () => {
    const zero: BalanceBuckets = { on_hand: 0, allocated: 0, hold: 0, inspect: 0, damaged: 0, in_transit: 0 }
    const mv = (p: Partial<StockMovement>): StockMovement => ({
      type: 'RECEIVE', sku: 'A', lot_id: 101, qty: 0, warehouse_id: 1, location_id: 1, ...p,
    })
    // Nhận 10 vào inspect tại vị trí nhận.
    let src = applyMovementToBalance({ ...zero }, mv({ type: 'RECEIVE', qty: 10, into_inspect: true }))
    assert.deepEqual([src.on_hand, src.inspect], [10, 10])
    // QC hỏng 4: inspect -> damaged (bắt buộc reason_code).
    src = applyMovementToBalance(src, mv({ type: 'DAMAGE', qty: 4, from_inspect: true, reason_code: 'DAMAGED' }))
    assert.deepEqual([src.on_hand, src.inspect, src.damaged], [10, 6, 4])
    // PUTAWAY ở tầng 1 balance = inspect -> khả dụng: on_hand không đổi,
    // inspect giảm, available tăng. (Chuyển KHÁC vị trí do tầng ghi xử lý hai
    // phía: nguồn on_hand-/inspect-, đích on_hand+ — xem ledger.ts/balance.ts,
    // kiểm chứng ở server smoke test.)
    assert.equal(src.available, 0)
    src = applyMovementToBalance(src, mv({ type: 'PUTAWAY', qty: 6, from_location_id: 1, location_id: 2 }))
    assert.deepEqual([src.on_hand, src.inspect, src.available], [10, 0, 6])
  })
})

describe('putaway suggestion', () => {
  it('(1) ưu tiên location đang chứa cùng SKU', () => {
    const s = suggestPutawayLocation('A', LOC, [
      { location_id: 4, sku: 'A', on_hand: 5 },
      { location_id: 2, sku: 'B', on_hand: 3 },
    ])
    assert.equal(s?.id, 4)
  })

  it('(2) PICKABLE trống cùng zone với location chứa cùng SKU (inspect không tính chứa)', () => {
    // SKU A chỉ có ở inspect (vị trí nhận, zone 1) và vị trí 4 (zone 3) chứa SKU khác.
    const s = suggestPutawayLocation('A', LOC, [
      { location_id: 1, sku: 'A', on_hand: 10 },
      { location_id: 4, sku: 'B', on_hand: 2 },
    ])
    // Không có PICKABLE trống cùng zone 3? Có: không — vị trí 4 không trống.
    // Quy tắc 2 cần location chứa cùng SKU *trên kệ* -> ở đây không có nên xuống (3).
    assert.equal(s?.id, 2)
  })

  it('(3) PICKABLE trống bất kỳ theo pick_sequence; bỏ qua location đã tắt', () => {
    const s = suggestPutawayLocation('ZZZ', LOC, [])
    assert.equal(s?.id, 2) // A01-01 seq 101, không phải A01-03 (đã tắt)
  })

  it('(4) BULK trống khi không còn PICKABLE trống', () => {
    const full = LOC.filter((l) => l.loc_type === 'PICKABLE' && l.active === 1)
      .map((l) => ({ location_id: l.id, sku: 'X', on_hand: 1 }))
    const s = suggestPutawayLocation('ZZZ', LOC, full)
    assert.equal(s?.id, 5) // BULK-01
  })

  it('không bao giờ gợi ý RECEIVING/DAMAGE/HOLD', () => {
    const only = LOC.filter((l) => ['RECEIVING', 'DAMAGE'].includes(l.loc_type))
    assert.equal(suggestPutawayLocation('A', only, []), null)
    const s = suggestPutawayLocation('A', LOC, [{ location_id: 6, sku: 'A', on_hand: 9 }])
    assert.notEqual(s?.id, 6) // HONG-01 chứa SKU nhưng là DAMAGE -> không gợi ý
    assert.notEqual(s?.id, 1)
  })

  it('planPutaway chặn cất vượt số chờ, cất vào RECEIVING, cất tại chỗ', () => {
    const line = {
      id: 5, receipt_id: 3, sku: 'A', lot_id: 101,
      qty_received: 10, qty_qc_pass: 6, qty_qc_fail: 4, qty_putaway: 0,
    }
    const ctx = { warehouse_id: 1, receiving_location_id: 1, actor: 'tester' }
    assert.equal(planPutaway(line, { qty: 7, to_location_id: 2 }, ctx, LOC).ok, false)
    assert.equal(planPutaway(line, { qty: 3, to_location_id: 1 }, ctx, LOC).ok, false)
    const r = planPutaway(line, { qty: 6, to_location_id: 2 }, ctx, LOC)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.plan.movements[0].type, 'PUTAWAY')
      assert.equal(r.plan.movements[0].from_location_id, 1)
      assert.equal(r.plan.movements[0].location_id, 2)
    }
  })
})

describe('permissions GĐ1', () => {
  it('purchase_receive: THU_KHO + NV_NHAN_HANG có, KE_TOAN_XEM + NV_LAY_HANG không', () => {
    assert.equal(hasPermission('KHO_ADMIN', 'purchase_receive'), true)
    assert.equal(hasPermission('THU_KHO', 'purchase_receive'), true)
    assert.equal(hasPermission('NV_NHAN_HANG', 'purchase_receive'), true)
    assert.equal(hasPermission('NV_LAY_HANG', 'purchase_receive'), false)
    assert.equal(hasPermission('KE_TOAN_XEM', 'purchase_receive'), false)
    assert.equal(hasPermission('KE_TOAN_XEM', 'purchase_create'), false)
    assert.equal(hasPermission('KE_TOAN_XEM', 'inventory_view'), true)
  })
})
