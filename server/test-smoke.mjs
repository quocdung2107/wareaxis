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

  const backup = await call('POST', '/api/admin/backup', { token })
  assert.equal(backup.status, 200)
  assert.ok(fs.existsSync(path.join(tmp, 'backups', backup.json.file)), 'file backup phải tồn tại')
  console.log('✓ backup tạo file trong data/backups/')

  console.log('\nSMOKE TEST PASS')
} finally {
  child.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}
