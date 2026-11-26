// Kiểm thử khói (smoke test) cho Warehouse Server — chạy độc lập, KHÔNG nằm trong `npm test`:
//   node server/test-smoke.mjs
// Khởi động server thật ở cổng test với DB tạm, đi hết luồng:
// health -> login -> đăng ký thiết bị (PENDING, bị chặn) -> duyệt -> movement -> balances
// -> chặn âm/thiếu lý do -> federation ping/availability -> backup. Tự dọn DB tạm.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const PORT = 18787
const BASE = `http://127.0.0.1:${PORT}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-smoke-'))
const env = {
  ...process.env,
  WMS_PORT: String(PORT),
  WMS_DATA_DIR: tmp,
  WMS_DB_PATH: path.join(tmp, 'warehouse.db'),
  WMS_ADMIN_USER: 'admin',
  WMS_ADMIN_PASS: 'smoke-pass-123',
  WMS_WAREHOUSE_CODE: 'KHO-TEST',
  WMS_FEDERATION_KEY: 'fed-key-smoke',
}
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'index.js')
const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

const call = async (method, p, { token, device, fedKey, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (device) { headers['x-device-id'] = String(device.id); headers['x-device-token'] = device.token }
  if (fedKey) headers['x-federation-key'] = fedKey
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

try {
  // Chờ server lên
  let up = false
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await call('GET', '/api/health'); up = r.status === 200 && r.json.ok === true } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  assert.ok(up, 'server không lên được')
  console.log('✓ health')

  const bad = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'sai' } })
  assert.equal(bad.status, 401)
  const login = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'smoke-pass-123' } })
  assert.equal(login.status, 200)
  const token = login.json.token
  assert.ok(token)
  console.log('✓ login (sai mật khẩu bị 401, đúng được token)')

  const noDevice = await call('GET', '/api/inventory/balances', { token })
  assert.equal(noDevice.status, 403)
  assert.equal(noDevice.json.error, 'missing_device')
  console.log('✓ API nghiệp vụ chặn khi chưa có thiết bị')

  const reg = await call('POST', '/api/devices/register', { token, body: { device_name: 'Điện thoại khói' } })
  assert.equal(reg.status, 201)
  assert.equal(reg.json.status, 'PENDING')
  const device = { id: reg.json.id, token: reg.json.device_token }

  const blocked = await call('POST', '/api/inventory/movements', {
    token, device, body: { type: 'RECEIVE', sku: 'SMOKE-1', qty: 100 },
  })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.json.error, 'device_not_approved')
  console.log('✓ thiết bị PENDING bị chặn khỏi API nghiệp vụ')

  const approve = await call('POST', `/api/devices/${device.id}/approve`, { token })
  assert.equal(approve.status, 200)
  assert.equal(approve.json.status, 'APPROVED')
  console.log('✓ admin duyệt thiết bị')

  const recv = await call('POST', '/api/inventory/movements', { token, device, body: { type: 'RECEIVE', sku: 'SMOKE-1', qty: 100 } })
  assert.equal(recv.status, 201, JSON.stringify(recv.json))
  assert.equal(recv.json.balance.on_hand, 100)
  const alloc = await call('POST', '/api/inventory/movements', { token, device, body: { type: 'ALLOCATE', sku: 'SMOKE-1', qty: 30 } })
  assert.equal(alloc.json.balance.available, 70)
  const pick = await call('POST', '/api/inventory/movements', { token, device, body: { type: 'PICK', sku: 'SMOKE-1', qty: 30 } })
  assert.equal(pick.json.balance.on_hand, 70)
  console.log('✓ RECEIVE 100 -> ALLOCATE 30 -> PICK 30: on_hand=70, available=70')

  const over = await call('POST', '/api/inventory/movements', { token, device, body: { type: 'PICK', sku: 'SMOKE-1', qty: 1000 } })
  assert.equal(over.status, 400)
  const noReason = await call('POST', '/api/inventory/movements', { token, device, body: { type: 'ADJUST_OUT', sku: 'SMOKE-1', qty: 1 } })
  assert.equal(noReason.status, 400)
  console.log('✓ chặn pick vượt tồn + ADJUST thiếu lý do')

  const balances = await call('GET', '/api/inventory/balances?sku=SMOKE-1', { token, device })
  assert.equal(balances.json.balances.length, 1)
  assert.equal(balances.json.balances[0].available, 70)
  const history = await call('GET', '/api/inventory/movements?sku=SMOKE-1', { token, device })
  assert.equal(history.json.movements.length, 3)
  console.log('✓ balances + lịch sử movements')

  const ping = await call('GET', '/federation/v1/ping')
  assert.equal(ping.json.warehouse_code, 'KHO-TEST')
  const fedNoKey = await call('GET', '/federation/v1/inventory/availability?sku=SMOKE-1')
  assert.equal(fedNoKey.status, 403)
  const fed = await call('GET', '/federation/v1/inventory/availability?sku=SMOKE-1', { fedKey: 'fed-key-smoke' })
  assert.equal(fed.status, 200)
  assert.equal(fed.json.total_available, 70)
  assert.ok(!('purchase_price' in fed.json) && !JSON.stringify(fed.json).includes('supplier'), 'federation không lộ giá/NCC')
  console.log('✓ federation ping + availability (có khoá mới xem được)')

  // --- GĐ1: PO -> gửi -> nhận thiếu + có hỏng -> QC -> putaway -> balances ---
  const locs = await call('GET', '/api/locations', { token, device })
  assert.equal(locs.status, 200)
  const recvLoc = locs.json.locations.find((l) => l.loc_type === 'RECEIVING')
  const pickLoc = locs.json.locations.find((l) => l.code === 'A01-01')
  assert.ok(recvLoc && pickLoc, 'seed phải có vị trí nhận + A01-01')

  const po = await call('POST', '/api/purchase-orders', {
    token, device,
    body: { lines: [{ sku: 'GD1-1', description: 'Hàng khói GĐ1', qty_ordered: 10, unit_price: 1000 }] },
  })
  assert.equal(po.status, 201, JSON.stringify(po.json))
  assert.match(po.json.po_no, /^PO-\d{4}$/)
  const poId = po.json.id

  const poFull0 = await call('GET', `/api/purchase-orders/${poId}`, { token, device })
  const poLineId = poFull0.json.lines[0].id
  const early = await call('POST', `/api/purchase-orders/${poId}/receive`, {
    token, device, body: { lines: [{ po_line_id: poLineId, qty_received: 1 }] },
  })
  assert.equal(early.status, 400) // PO còn DRAFT, chưa nhận được

  const sent = await call('POST', `/api/purchase-orders/${poId}/transition`, { token, device, body: { to: 'SENT' } })
  assert.equal(sent.status, 200)

  // Nhận 8/10 (thiếu 2), trong đó hỏng 1.
  const rcv = await call('POST', `/api/purchase-orders/${poId}/receive`, {
    token, device, body: { lines: [{ po_line_id: poLineId, qty_received: 8, qty_damaged: 1, batch_no: 'B1' }] },
  })
  assert.equal(rcv.status, 201, JSON.stringify(rcv.json))
  const receiptId = rcv.json.receipt_id

  const poAfter = await call('GET', `/api/purchase-orders/${poId}`, { token, device })
  assert.equal(poAfter.json.order.status, 'PARTIAL')
  const rl = poAfter.json.receipts[0].lines[0]
  assert.equal(rl.qty_shortage, 2)
  assert.equal(rl.qty_good, 7)
  assert.ok(rl.lot_id > 0, 'mỗi dòng nhận sinh 1 lô mới')

  const balOf = async () => (await call('GET', '/api/inventory/balances?sku=GD1-1', { token, device })).json.balances
  let atRecv = (await balOf()).find((b) => b.location_id === recvLoc.id)
  assert.deepEqual([atRecv.on_hand, atRecv.inspect, atRecv.available], [8, 8, 0])
  console.log('✓ GĐ1 nhận hàng: PO PARTIAL, thiếu 2, tồn vào inspect tại vị trí nhận')

  // QC: đạt 7, hỏng 1 (bắt buộc lý do).
  const qcNoReason = await call('POST', `/api/receipts/${receiptId}/qc`, {
    token, device, body: { receipt_line_id: rl.id, qty_pass: 7, qty_fail: 1 },
  })
  assert.equal(qcNoReason.status, 400)
  const qc = await call('POST', `/api/receipts/${receiptId}/qc`, {
    token, device, body: { receipt_line_id: rl.id, qty_pass: 7, qty_fail: 1, reason_code: 'DAMAGED' },
  })
  assert.equal(qc.status, 200, JSON.stringify(qc.json))
  atRecv = (await balOf()).find((b) => b.location_id === recvLoc.id)
  assert.deepEqual([atRecv.on_hand, atRecv.inspect, atRecv.damaged], [8, 7, 1])
  console.log('✓ GĐ1 QC: hỏng chuyển inspect -> damaged, thiếu lý do bị chặn')

  // Putaway 7 sang A01-01.
  const put = await call('POST', `/api/receipts/${receiptId}/putaway`, {
    token, device, body: { receipt_line_id: rl.id, qty: 7, to_location_id: pickLoc.id },
  })
  assert.equal(put.status, 200, JSON.stringify(put.json))
  const all = await balOf()
  atRecv = all.find((b) => b.location_id === recvLoc.id)
  const atPick = all.find((b) => b.location_id === pickLoc.id)
  assert.deepEqual([atRecv.on_hand, atRecv.inspect, atRecv.damaged], [1, 0, 1])
  assert.deepEqual([atPick.on_hand, atPick.available], [7, 7])

  const lots = await call('GET', '/api/lots?sku=GD1-1', { token, device })
  assert.equal(lots.json.lots.length, 1)
  assert.equal(lots.json.lots[0].status, 'AVAILABLE')
  assert.equal(lots.json.lots[0].location_id, pickLoc.id)
  const fedGd1 = await call('GET', '/federation/v1/inventory/availability?sku=GD1-1', { fedKey: 'fed-key-smoke' })
  assert.equal(fedGd1.json.total_available, 7)
  console.log('✓ GĐ1 putaway: đích on_hand=7 khả dụng=7, lô AVAILABLE, federation thấy SKU mới')

  const backup = await call('POST', '/api/admin/backup', { token })
  assert.equal(backup.status, 200)
  assert.ok(fs.existsSync(path.join(tmp, 'backups', backup.json.file)), 'file backup phải tồn tại')
  console.log('✓ backup tạo file trong data/backups/')

  console.log('\nSMOKE TEST PASS')
} finally {
  child.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}
