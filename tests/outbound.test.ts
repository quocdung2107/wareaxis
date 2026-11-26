// GĐ2 — outbound: allocation FEFO/FIFO + backorder, wave gộp task + route,
// pack verify, returns về đúng lô gốc, quyền outbound. Logic thuần ở
// src/domain/outbound (+ tái dùng domain/inbound cho QC/putaway hàng trả).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertObTransition, canTransitionOb, obStatusAfterAllocation, validateOutboundInput,
} from '../src/domain/outbound/outbound-order.ts'
import {
  allocateLine, candidateAvailable, type AllocationCandidate,
} from '../src/domain/outbound/allocation.ts'
import { buildPickTasks, planPickConfirm, type AllocationPickState } from '../src/domain/outbound/wave.ts'
import { summarizePack, verifyPackScan } from '../src/domain/outbound/pack.ts'
import { planReturn, planReturnQc, returnStatusAfter } from '../src/domain/outbound/returns.ts'
import { can as hasPermission } from '../src/domain/permissions/guard.ts'

const cand = (p: Partial<AllocationCandidate>): AllocationCandidate => ({
  lot_id: 1, location_id: 10, sku: 'SKU-1', lot_status: 'AVAILABLE', loc_type: 'PICKABLE',
  location_active: 1, expiry_date: null,
  on_hand: 10, allocated: 0, hold: 0, damaged: 0, inspect: 0, ...p,
})

describe('đơn xuất — trạng thái + validate', () => {
  it('luồng DRAFT->ALLOCATED->PICKING->PACKED->SHIPPED->COMPLETED; huỷ chỉ khi chưa pick', () => {
    assert.equal(canTransitionOb('DRAFT', 'ALLOCATED'), true)
    assert.equal(canTransitionOb('DRAFT', 'PARTIAL_ALLOCATED'), true)
    assert.equal(canTransitionOb('ALLOCATED', 'PICKING'), true)
    assert.equal(canTransitionOb('PICKING', 'PACKED'), true)
    assert.equal(canTransitionOb('PACKED', 'SHIPPED'), true)
    assert.equal(canTransitionOb('SHIPPED', 'COMPLETED'), true)
    assert.equal(canTransitionOb('ALLOCATED', 'CANCELLED'), true)
    assert.equal(canTransitionOb('PICKING', 'CANCELLED'), false)
    assert.equal(canTransitionOb('DRAFT', 'PACKED'), false)
    assert.throws(() => assertObTransition('COMPLETED', 'DRAFT'), /Không chuyển được đơn xuất/)
  })

  it('rollup phân bổ: đủ -> ALLOCATED, thiếu -> PARTIAL_ALLOCATED', () => {
    assert.equal(obStatusAfterAllocation([{ qty_ordered: 5, qty_allocated: 5 }]), 'ALLOCATED')
    assert.equal(obStatusAfterAllocation([{ qty_ordered: 5, qty_allocated: 3 }]), 'PARTIAL_ALLOCATED')
    assert.equal(obStatusAfterAllocation([{ qty_ordered: 5, qty_allocated: 0 }]), 'PARTIAL_ALLOCATED')
    assert.equal(obStatusAfterAllocation([
      { qty_ordered: 5, qty_allocated: 5 }, { qty_ordered: 2, qty_allocated: 1 },
    ]), 'PARTIAL_ALLOCATED')
  })

  it('validate: cần ít nhất 1 dòng, SKU + SL hợp lệ', () => {
    assert.match(validateOutboundInput({ lines: [] }) ?? '', /ít nhất 1 dòng/)
    assert.match(validateOutboundInput({ lines: [{ sku: ' ', qty_ordered: 1 }] }) ?? '', /chưa nhập SKU/)
    assert.match(validateOutboundInput({ lines: [{ sku: 'A', qty_ordered: 0 }] }) ?? '', /lớn hơn 0/)
    assert.equal(validateOutboundInput({ lines: [{ sku: 'A', qty_ordered: 2 }] }), null)
  })
})

describe('allocation', () => {
  it('FEFO: lô hết hạn sớm lấy trước, lô không có hạn dùng xuống cuối, hoà thì lot nhỏ trước', () => {
    const cs = [
      cand({ lot_id: 3, location_id: 12, expiry_date: '2027-06-01', on_hand: 5 }),
      cand({ lot_id: 2, location_id: 11, expiry_date: null, on_hand: 5 }),
      cand({ lot_id: 1, location_id: 10, expiry_date: '2026-01-01', on_hand: 5 }),
      cand({ lot_id: 4, location_id: 13, expiry_date: '2026-01-01', on_hand: 5 }),
    ]
    const r = allocateLine('SKU-1', 12, cs, 'FEFO')
    assert.deepEqual(r.allocations.map((a) => a.lot_id), [1, 4, 3])
    assert.deepEqual(r.allocations.map((a) => a.qty), [5, 5, 2])
    assert.equal(r.backorder, 0)
  })

  it('FIFO: theo lot_id tăng dần, bất kể hạn dùng', () => {
    const cs = [
      cand({ lot_id: 9, expiry_date: '2026-01-01', on_hand: 4 }),
      cand({ lot_id: 2, expiry_date: '2030-01-01', on_hand: 4 }),
    ]
    const r = allocateLine('SKU-1', 6, cs, 'FIFO')
    assert.deepEqual(r.allocations.map((a) => a.lot_id), [2, 9])
    assert.deepEqual(r.allocations.map((a) => a.qty), [4, 2])
  })

  it('thiếu hàng -> partial + backorder đúng phần thiếu', () => {
    const r = allocateLine('SKU-1', 10, [cand({ on_hand: 4 }), cand({ lot_id: 2, location_id: 11, on_hand: 3 })])
    assert.equal(r.qty_allocated, 7)
    assert.equal(r.backorder, 3)
  })

  it('bỏ qua phần frozen/inspect/damaged/đã giữ và lô/vị trí không hợp lệ', () => {
    // on_hand 10 nhưng hold 3 + damaged 2 + inspect 4 + allocated 1 -> khả dụng 0
    assert.equal(candidateAvailable(cand({ on_hand: 10, hold: 3, damaged: 2, inspect: 4, allocated: 1 })), 0)
    const cs = [
      cand({ lot_id: 1, on_hand: 10, hold: 10 }), // đóng băng hết
      cand({ lot_id: 2, location_id: 11, lot_status: 'INSPECT', on_hand: 10 }), // lô chưa QC xong
      cand({ lot_id: 3, location_id: 12, loc_type: 'RECEIVING', on_hand: 10 }), // vị trí nhận — không pick
      cand({ lot_id: 4, location_id: 13, loc_type: 'DAMAGE', on_hand: 10 }),
      cand({ lot_id: 5, location_id: 14, on_hand: 10, inspect: 10 }), // đang chờ QC
      cand({ lot_id: 6, location_id: 15, on_hand: 10, damaged: 10 }), // hỏng hết
      cand({ lot_id: 7, location_id: 16, on_hand: 6, allocated: 2 }), // khả dụng 4
      cand({ lot_id: 8, location_id: 17, sku: 'SKU-KHAC', on_hand: 10 }), // khác SKU
    ]
    const r = allocateLine('SKU-1', 10, cs)
    assert.deepEqual(r.allocations, [{ lot_id: 7, location_id: 16, qty: 4 }])
    assert.equal(r.backorder, 6)
  })
})

describe('wave + pick', () => {
  it('gộp allocations cùng (lô, vị trí) thành 1 task, sắp theo pick_sequence rồi mã vị trí', () => {
    const tasks = buildPickTasks([
      { allocation_id: 1, order_id: 1, order_line_id: 1, lot_id: 5, location_id: 20, location_code: 'B01-01', pick_sequence: 201, sku: 'SKU-1', qty_remaining: 3 },
      { allocation_id: 2, order_id: 2, order_line_id: 3, lot_id: 5, location_id: 20, location_code: 'B01-01', pick_sequence: 201, sku: 'SKU-1', qty_remaining: 2 },
      { allocation_id: 3, order_id: 1, order_line_id: 2, lot_id: 6, location_id: 10, location_code: 'A01-01', pick_sequence: 101, sku: 'SKU-1', qty_remaining: 4 },
      { allocation_id: 4, order_id: 2, order_line_id: 4, lot_id: 7, location_id: 30, location_code: 'C01-01', pick_sequence: null, sku: 'SKU-2', qty_remaining: 1 },
    ])
    assert.equal(tasks.length, 3)
    assert.deepEqual(tasks.map((t) => t.location_code), ['A01-01', 'B01-01', 'C01-01']) // null sequence xuống cuối
    const merged = tasks[1]
    assert.equal(merged.qty_need, 5)
    assert.deepEqual(merged.parts, [
      { allocation_id: 1, qty: 3 }, { allocation_id: 2, qty: 2 },
    ])
  })

  const pickState = (p: Partial<AllocationPickState>): AllocationPickState => ({
    allocation_id: 1, order_id: 1, order_line_id: 1, lot_id: 5, location_id: 10, sku: 'SKU-1',
    qty_allocated: 5, qty_picked: 0, qty_covered: 5, ...p,
  })

  it('xác nhận đủ -> PICK, task PICKED, không nhả', () => {
    const r = planPickConfirm([pickState({})], 5, { warehouse_id: 1 })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.plan.task_status, 'PICKED')
    assert.equal(r.plan.total_picked, 5)
    assert.equal(r.plan.total_released, 0)
    assert.deepEqual(r.plan.movements.map((m) => m.type), ['PICK'])
    assert.equal(r.plan.per_allocation[0].new_status, 'PICKED')
  })

  it('lấy thiếu -> PICK phần lấy + DEALLOCATE phần thiếu (về backorder), task SHORT', () => {
    const r = planPickConfirm([pickState({})], 3, { warehouse_id: 1 })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.plan.task_status, 'SHORT')
    assert.deepEqual(
      r.plan.movements.map((m) => [m.type, m.qty]),
      [['PICK', 3], ['DEALLOCATE', 2]],
    )
    const s = r.plan.per_allocation[0]
    assert.equal(s.new_status, 'SHORT')
    assert.equal(s.qty_allocated_after, 3) // cam kết giảm -> backorder của dòng tăng lại 2
    assert.equal(s.qty_picked_after, 3)
  })

  it('lấy vượt phân bổ của task bị chặn; phân bổ SL lấy theo thứ tự allocation', () => {
    const bad = planPickConfirm([pickState({})], 6, { warehouse_id: 1 })
    assert.equal(bad.ok, false)
    const states = [
      pickState({ allocation_id: 1, qty_allocated: 3, qty_covered: 3 }),
      pickState({ allocation_id: 2, order_id: 2, order_line_id: 9, qty_allocated: 4, qty_covered: 4 }),
    ]
    const r = planPickConfirm(states, 5, { warehouse_id: 1 })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.plan.per_allocation.map((s) => s.qty_pick_now), [3, 2])
    assert.deepEqual(r.plan.per_allocation.map((s) => s.qty_release), [0, 2])
  })
})

describe('pack verify', () => {
  const lines = [
    { sku: 'SKU-1', qty_picked: 5, qty_packed: 2 },
    { sku: 'SKU-2', qty_picked: 3, qty_packed: 0 },
  ]

  it('sai SKU (không thuộc đơn / chưa lấy) -> lỗi rõ ràng', () => {
    const r = verifyPackScan(lines, { sku: 'SKU-LA', qty: 1 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /không thuộc phần đã lấy/)
  })

  it('vượt SL đã lấy (tính cả phần đã gói) -> lỗi', () => {
    const r = verifyPackScan(lines, { sku: 'SKU-1', qty: 4 })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /vượt số đã lấy/)
    assert.equal(verifyPackScan(lines, { sku: 'SKU-1', qty: 3 }).ok, true)
  })

  it('summarizePack: áp scan tuần tự, đủ mọi SKU -> complete', () => {
    const r = summarizePack(lines, [{ sku: 'SKU-1', qty: 3 }, { sku: 'sku-2', qty: 3 }])
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.summary.complete, true)
    assert.deepEqual(
      r.summary.items.map((i) => [i.sku, i.qty_packed, i.qty_picked]),
      [['SKU-1', 5, 5], ['SKU-2', 3, 3]],
    )
    const partial = summarizePack(lines, [{ sku: 'SKU-1', qty: 3 }])
    assert.equal(partial.ok, true)
    if (partial.ok) assert.equal(partial.summary.complete, false)
  })
})

describe('returns', () => {
  const item = { id: 7, sku: 'SKU-1', lot_id: 42, qty_shipped: 5, qty_returned: 1 }
  const ctx = { warehouse_id: 1, receiving_location_id: 1, return_id: 3 }

  it('trả vượt SL đã giao còn lại bị chặn', () => {
    const r = planReturn(item, 5, ctx)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /vượt số đã giao/)
  })

  it('kế hoạch trả: RETURN_IN vào inspect, gắn đúng lô gốc, doc RETURN', () => {
    const r = planReturn(item, 2, ctx)
    assert.equal(r.ok, true)
    if (!r.ok) return
    const m = r.plan.movements[0]
    assert.equal(m.type, 'RETURN_IN')
    assert.equal(m.into_inspect, true)
    assert.equal(m.lot_id, 42)
    assert.equal(m.location_id, 1)
    assert.equal(m.doc_type, 'RETURN')
    assert.equal(m.doc_id, 3)
  })

  it('QC hàng trả tái dùng planQc inbound: hỏng bắt buộc lý do, movement DAMAGE ghi doc RETURN', () => {
    const line = {
      id: 1, receipt_id: 3, sku: 'SKU-1', lot_id: 42,
      qty_received: 2, qty_qc_pass: 0, qty_qc_fail: 0, qty_putaway: 0,
    }
    const noReason = planReturnQc(line, { qty_pass: 1, qty_fail: 1 }, { warehouse_id: 1, receiving_location_id: 1 })
    assert.equal(noReason.ok, false)
    const ok = planReturnQc(line, { qty_pass: 1, qty_fail: 1, reason_code: 'RETURN_QC' },
      { warehouse_id: 1, receiving_location_id: 1 })
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    assert.equal(ok.plan.qc_status, 'PARTIAL')
    const dmg = ok.plan.movements.find((m) => m.type === 'DAMAGE')
    assert.ok(dmg)
    assert.equal(dmg?.doc_type, 'RETURN')
    assert.equal(dmg?.from_inspect, true)
  })

  it('trạng thái phiếu trả: RECEIVED -> QC_DONE -> DONE', () => {
    const base = { qty_received: 2, qty_qc_pass: 0, qty_qc_fail: 0, qty_putaway: 0 }
    assert.equal(returnStatusAfter([base]), 'RECEIVED')
    assert.equal(returnStatusAfter([{ ...base, qty_qc_pass: 2 }]), 'QC_DONE')
    assert.equal(returnStatusAfter([{ ...base, qty_qc_pass: 2, qty_putaway: 2 }]), 'DONE')
    assert.equal(returnStatusAfter([{ ...base, qty_qc_fail: 2 }]), 'DONE') // hỏng hết: QC xong, không còn gì cất
  })
})

describe('quyền outbound GĐ2', () => {
  it('KHO_ADMIN + THU_KHO có đủ 5 quyền outbound/returns', () => {
    for (const role of ['KHO_ADMIN', 'THU_KHO'] as const) {
      for (const p of ['outbound_allocate', 'outbound_pick', 'outbound_pack', 'outbound_ship', 'returns_receive'] as const) {
        assert.equal(hasPermission(role, p), true, `${role}:${p}`)
      }
    }
  })

  it('NV_LAY_HANG: pick + pack, không allocate/ship/returns', () => {
    assert.equal(hasPermission('NV_LAY_HANG', 'outbound_pick'), true)
    assert.equal(hasPermission('NV_LAY_HANG', 'outbound_pack'), true)
    assert.equal(hasPermission('NV_LAY_HANG', 'outbound_allocate'), false)
    assert.equal(hasPermission('NV_LAY_HANG', 'outbound_ship'), false)
    assert.equal(hasPermission('NV_LAY_HANG', 'returns_receive'), false)
  })

  it('NV_NHAN_HANG: nhận hàng trả, không outbound; KE_TOAN_XEM không có quyền outbound nào', () => {
    assert.equal(hasPermission('NV_NHAN_HANG', 'returns_receive'), true)
    assert.equal(hasPermission('NV_NHAN_HANG', 'outbound_pick'), false)
    for (const p of ['outbound_allocate', 'outbound_pick', 'outbound_pack', 'outbound_ship', 'returns_receive'] as const) {
      assert.equal(hasPermission('KE_TOAN_XEM', p), false, p)
    }
  })
})
