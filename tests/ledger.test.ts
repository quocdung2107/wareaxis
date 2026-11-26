import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMovementToBalance, applyReversal } from '../src/domain/ledger/apply.ts'
import { rebuildBalances, balanceKeyOf } from '../src/domain/ledger/balance.ts'
import {
  availableOf, emptyBuckets, type StockBalance, type StockMovement,
} from '../src/domain/ledger/types.ts'
import { ADJUSTMENT_REASONS, REASON_CODES } from '../src/domain/ledger/reasons.ts'

const bal = (o: Partial<StockBalance> = {}): StockBalance => ({
  warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1',
  ...emptyBuckets(), available: 0, ...o,
})
const withAvail = (b: StockBalance): StockBalance => ({ ...b, available: availableOf(b) })
const mv = (o: Partial<StockMovement>): StockMovement => ({
  warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1', type: 'RECEIVE', qty: 1, ...o,
})

test('RECEIVE cộng on_hand, available tăng theo', () => {
  const b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 100 }))
  assert.equal(b.on_hand, 100)
  assert.equal(b.available, 100)
})

test('ALLOCATE trừ available nhưng không trừ on_hand; DEALLOCATE trả lại', () => {
  let b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 50 }))
  b = applyMovementToBalance(b, mv({ type: 'ALLOCATE', qty: 20 }))
  assert.equal(b.on_hand, 50)
  assert.equal(b.allocated, 20)
  assert.equal(b.available, 30)
  b = applyMovementToBalance(b, mv({ type: 'DEALLOCATE', qty: 20 }))
  assert.equal(b.available, 50)
})

test('ALLOCATE vượt available bị chặn', () => {
  const b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 10 }))
  assert.throws(() => applyMovementToBalance(b, mv({ type: 'ALLOCATE', qty: 11 })), /khả dụng âm|âm/)
})

test('PICK trừ on_hand và tiêu thụ allocated trước; pick lẻ không allocation vẫn được', () => {
  let b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 50 }))
  b = applyMovementToBalance(b, mv({ type: 'ALLOCATE', qty: 20 }))
  b = applyMovementToBalance(b, mv({ type: 'PICK', qty: 20 }))
  assert.equal(b.on_hand, 30)
  assert.equal(b.allocated, 0)
  b = applyMovementToBalance(b, mv({ type: 'PICK', qty: 5 }))
  assert.equal(b.on_hand, 25)
  assert.throws(() => applyMovementToBalance(b, mv({ type: 'PICK', qty: 26 })), /vượt tồn/)
})

test('FREEZE/UNFREEZE di chuyển giữa available và hold', () => {
  let b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 40 }))
  b = applyMovementToBalance(b, mv({ type: 'FREEZE', qty: 15 }))
  assert.equal(b.hold, 15)
  assert.equal(b.available, 25)
  assert.equal(b.on_hand, 40)
  b = applyMovementToBalance(b, mv({ type: 'UNFREEZE', qty: 15 }))
  assert.equal(b.hold, 0)
  assert.equal(b.available, 40)
  assert.throws(() => applyMovementToBalance(b, mv({ type: 'FREEZE', qty: 41 })), /âm/)
})

test('PUTAWAY chỉ giảm inspect; DAMAGE đánh dấu hỏng trừ available', () => {
  let b = withAvail(bal({ on_hand: 30, inspect: 30 }))
  b = applyMovementToBalance(b, mv({ type: 'PUTAWAY', qty: 30 }))
  assert.equal(b.inspect, 0)
  assert.equal(b.available, 30)
  b = applyMovementToBalance(b, mv({ type: 'DAMAGE', qty: 5, reason_code: 'DAMAGED' }))
  assert.equal(b.damaged, 5)
  assert.equal(b.available, 25)
})

test('ADJUST/DAMAGE/WRITE_OFF bắt buộc reason_code thuộc danh mục', () => {
  const b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 10 }))
  assert.throws(() => applyMovementToBalance(b, mv({ type: 'ADJUST_OUT', qty: 1 })), /bắt buộc có lý do/)
  assert.throws(() => applyMovementToBalance(b, mv({ type: 'ADJUST_OUT', qty: 1, reason_code: 'KHONG_CO' })), /không có trong danh mục/)
  const b2 = applyMovementToBalance(b, mv({ type: 'ADJUST_OUT', qty: 3, reason_code: 'COUNT_VARIANCE' }))
  assert.equal(b2.on_hand, 7)
  const b3 = applyMovementToBalance(b2, mv({ type: 'ADJUST_IN', qty: 2, reason_code: 'FOUND' }))
  assert.equal(b3.on_hand, 9)
})

test('WRITE_OFF trừ damaged trước; TRANSFER_OUT/IN qua in_transit', () => {
  let b = withAvail(bal({ on_hand: 20, damaged: 5 }))
  b = applyMovementToBalance(b, mv({ type: 'WRITE_OFF', qty: 5, reason_code: 'DAMAGED' }))
  assert.equal(b.on_hand, 15)
  assert.equal(b.damaged, 0)
  b = applyMovementToBalance(b, mv({ type: 'TRANSFER_OUT', qty: 10 }))
  assert.equal(b.on_hand, 5)
  assert.equal(b.in_transit, 10)
  b = applyMovementToBalance(b, mv({ type: 'TRANSFER_IN', qty: 10 }))
  assert.equal(b.on_hand, 15)
  assert.equal(b.in_transit, 0)
})

test('qty <= 0 và SKU rỗng bị từ chối; không sửa balance đầu vào', () => {
  const b0 = bal()
  assert.throws(() => applyMovementToBalance(b0, mv({ type: 'RECEIVE', qty: 0 })), /lớn hơn 0/)
  assert.throws(() => applyMovementToBalance(b0, mv({ type: 'RECEIVE', qty: 1, sku: ' ' })), /thiếu SKU/)
  applyMovementToBalance(b0, mv({ type: 'RECEIVE', qty: 3 }))
  assert.equal(b0.on_hand, 0)
})

test('REVERSAL: applyReversal đảo RECEIVE/ALLOCATE/FREEZE; REVERSAL thiếu gốc bị chặn', () => {
  let b = applyMovementToBalance(bal(), mv({ type: 'RECEIVE', qty: 30, id: 1 }))
  b = applyMovementToBalance(b, mv({ type: 'ALLOCATE', qty: 10, id: 2 }))
  b = applyReversal(b, mv({ type: 'ALLOCATE', qty: 10, id: 2 }))
  assert.equal(b.allocated, 0)
  assert.equal(b.available, 30)
  assert.throws(
    () => applyMovementToBalance(b, mv({ type: 'REVERSAL', qty: 1 })),
    /reverses_movement_id/,
  )
})

test('rebuildBalances dựng lại đúng từ movements, gồm MOVE hai phía', () => {
  const moves: StockMovement[] = [
    mv({ id: 1, type: 'RECEIVE', qty: 100 }),
    mv({ id: 2, type: 'ALLOCATE', qty: 30 }),
    mv({ id: 3, type: 'PICK', qty: 30 }),
    mv({ id: 4, type: 'FREEZE', qty: 10 }),
    mv({ id: 5, type: 'MOVE', qty: 20, from_location_id: 10, location_id: 11 }),
  ]
  const map = rebuildBalances(moves)
  const src = map.get(balanceKeyOf({ warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1' }))!
  assert.equal(src.on_hand, 50) // 100 - 30 pick - 20 move
  assert.equal(src.hold, 10)
  assert.equal(src.available, 40)
  const dst = map.get(balanceKeyOf({ warehouse_id: 1, location_id: 11, lot_id: 5, sku: 'S1' }))!
  assert.equal(dst.on_hand, 20)
  // Bất biến Phần 5.5 #2: tổng on_hand các balance == tổng RECEIVE - PICK
  const total = [...map.values()].reduce((s, b) => s + b.on_hand, 0)
  assert.equal(total, 70)
})

test('rebuildBalances: REVERSAL tra được movement gốc theo id', () => {
  const moves: StockMovement[] = [
    mv({ id: 1, type: 'RECEIVE', qty: 10 }),
    mv({ id: 2, type: 'REVERSAL', qty: 10, reverses_movement_id: 1 }),
  ]
  const map = rebuildBalances(moves)
  const b = map.get(balanceKeyOf({ warehouse_id: 1, location_id: 10, lot_id: 5, sku: 'S1' }))!
  assert.equal(b.on_hand, 0)
})

test('danh mục lý do seed đủ các mã kế hoạch yêu cầu', () => {
  for (const code of ['COUNT_VARIANCE', 'DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'INPUT_ERROR', 'RETURN_QC']) {
    assert.ok(REASON_CODES.has(code), code)
  }
  assert.ok(ADJUSTMENT_REASONS.find((r) => r.code === 'COUNT_VARIANCE')!.requires_approval)
})
