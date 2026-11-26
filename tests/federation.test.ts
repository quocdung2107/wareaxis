import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySharePolicy, normalizeBaseUrl, validatePeerConfig,
  DEFAULT_SHARE_POLICY, type AvailabilityRowInput,
} from '../src/domain/federation/policy.ts'

const ROWS: AvailabilityRowInput[] = [
  { sku: 'SKU-1', lot_id: 11, expiry_date: '2027-01-31', available: 25, purchase_price: 12000, unit_cost: 11500, internal_note: 'nội bộ' },
  { sku: 'SKU-1', lot_id: 12, expiry_date: null, available: 5, cost_price: 13000 },
  { sku: 'SKU-2', available: 0 },
]

test('applySharePolicy: mặc định bóc mọi trường giá vốn + trường lạ', () => {
  const out = applySharePolicy(ROWS, DEFAULT_SHARE_POLICY)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { sku: 'SKU-1', lot_id: 11, expiry_date: '2027-01-31', available: 25 })
  assert.deepEqual(out[1], { sku: 'SKU-1', lot_id: 12, expiry_date: null, available: 5 })
  assert.deepEqual(out[2], { sku: 'SKU-2', lot_id: null, expiry_date: null, available: 0 })
  for (const r of out) {
    assert.ok(!('purchase_price' in r) && !('unit_cost' in r) && !('cost_price' in r))
    assert.ok(!('internal_note' in r))
  }
})

test('applySharePolicy: tắt share_available -> rỗng, kể cả khi bật giá', () => {
  const out = applySharePolicy(ROWS, { share_available: false, share_low_stock: true, share_cost_price: true })
  assert.deepEqual(out, [])
})

test('applySharePolicy: bật share_cost_price -> giữ giá, vẫn chuẩn hoá dòng', () => {
  const out = applySharePolicy(ROWS, { share_available: true, share_low_stock: false, share_cost_price: true })
  assert.equal(out[0].purchase_price, 12000)
  assert.equal(out[0].unit_cost, 11500)
  assert.equal(out[1].cost_price, 13000)
  assert.ok(!('purchase_price' in out[1]), 'dòng không có giá đó thì không bịa thêm')
  assert.deepEqual(
    { sku: out[2].sku, lot_id: out[2].lot_id, expiry_date: out[2].expiry_date, available: out[2].available },
    { sku: 'SKU-2', lot_id: null, expiry_date: null, available: 0 },
  )
})

test('validatePeerConfig: cấu hình đúng -> không lỗi; normalizeBaseUrl bỏ / cuối', () => {
  assert.deepEqual(validatePeerConfig({ name: 'Kho B', base_url: 'http://100.64.0.2:8787/', api_key: 'fed_x' }), [])
  assert.deepEqual(validatePeerConfig({ name: 'Kho B', base_url: 'https://kho-b.tailnet:8787', api_key: 'fed_x' }), [])
  assert.equal(normalizeBaseUrl('http://kho:8787///'), 'http://kho:8787')
})

test('validatePeerConfig: thiếu tên / URL sai / thiếu khoá -> có lỗi rõ ràng', () => {
  const errs = validatePeerConfig({ name: '  ', base_url: 'khong-phai-url', api_key: '' })
  assert.equal(errs.length, 3)
  assert.match(errs[0], /Tên kho peer/)
  assert.match(errs[1], /URL hợp lệ/)
  assert.match(errs[2], /khoá liên kho/)
  const ftp = validatePeerConfig({ name: 'Kho C', base_url: 'ftp://kho-c:21', api_key: 'k' })
  assert.equal(ftp.length, 1)
  assert.match(ftp[0], /http/)
  assert.deepEqual(validatePeerConfig({}), [
    'Tên kho peer không được để trống',
    'Địa chỉ (base_url) của kho peer không được để trống',
    'Thiếu khoá liên kho (api_key) của kho peer',
  ])
})
