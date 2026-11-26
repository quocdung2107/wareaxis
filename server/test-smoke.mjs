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

  // --- GĐ2: đơn xuất 5 -> phân bổ -> wave -> pick -> pack -> ship -> trả 2 về lô gốc -> QC -> putaway ---
  const ob = await call('POST', '/api/outbound-orders', {
    token, device,
    body: { customer_name: 'Khách khói', lines: [{ sku: 'GD1-1', qty_ordered: 5 }] },
  })
  assert.equal(ob.status, 201, JSON.stringify(ob.json))
  assert.match(ob.json.order_no, /^XH-\d{4}$/)
  const obId = ob.json.id

  const allocRes = await call('POST', `/api/outbound-orders/${obId}/allocate`, { token, device, body: {} })
  assert.equal(allocRes.status, 200, JSON.stringify(allocRes.json))
  assert.equal(allocRes.json.status, 'ALLOCATED')
  assert.equal(allocRes.json.results[0].qty_allocated, 5)
  const balGd1 = async () => (await call('GET', '/api/inventory/balances?sku=GD1-1', { token, device })).json.balances
  let atPick2 = (await balGd1()).find((b) => b.location_id === pickLoc.id)
  assert.deepEqual([atPick2.on_hand, atPick2.allocated, atPick2.available], [7, 5, 2])
  console.log('✓ GĐ2 phân bổ: giữ 5 tại A01-01, khả dụng còn 2')

  const wave = await call('POST', '/api/waves', { token, device, body: { order_ids: [obId], carrier_text: 'Xe khói' } })
  assert.equal(wave.status, 201, JSON.stringify(wave.json))
  assert.match(wave.json.wave_no, /^WV-\d{4}$/)
  const waveTasks = await call('GET', `/api/waves/${wave.json.wave_id}/tasks`, { token, device })
  assert.equal(waveTasks.json.tasks.length, 1)
  assert.equal(waveTasks.json.tasks[0].qty_need, 5)
  const taskId = waveTasks.json.tasks[0].id

  const pickConfirm = await call('POST', `/api/pick-tasks/${taskId}/confirm`, { token, device, body: { qty: 5 } })
  assert.equal(pickConfirm.status, 200, JSON.stringify(pickConfirm.json))
  assert.equal(pickConfirm.json.status, 'PICKED')
  atPick2 = (await balGd1()).find((b) => b.location_id === pickLoc.id)
  assert.deepEqual([atPick2.on_hand, atPick2.allocated, atPick2.available], [2, 0, 2])
  console.log('✓ GĐ2 wave + pick: lấy đủ 5, tồn A01-01 còn 2')

  const packWrong = await call('POST', `/api/outbound-orders/${obId}/pack`, {
    token, device, body: { scans: [{ sku: 'SAI-1', qty: 1 }] },
  })
  assert.equal(packWrong.status, 400)
  const packOk = await call('POST', `/api/outbound-orders/${obId}/pack`, {
    token, device, body: { scans: [{ sku: 'GD1-1', qty: 5 }] },
  })
  assert.equal(packOk.status, 200, JSON.stringify(packOk.json))
  assert.equal(packOk.json.complete, true)
  console.log('✓ GĐ2 pack: sai SKU bị chặn, đúng SKU đủ -> PACKED')

  const ship = await call('POST', `/api/outbound-orders/${obId}/ship`, {
    token, device, body: { carrier_text: 'Xe khói', tracking_text: 'VD-SMOKE-1' },
  })
  assert.equal(ship.status, 201, JSON.stringify(ship.json))
  assert.match(ship.json.shipment_no, /^GH-\d{4}$/)
  const obAfter = await call('GET', `/api/outbound-orders/${obId}`, { token, device })
  assert.equal(obAfter.json.order.status, 'COMPLETED')
  const shipFull = await call('GET', `/api/shipments/${ship.json.shipment_id}`, { token, device })
  assert.equal(shipFull.json.items.length, 1)
  assert.equal(shipFull.json.items[0].qty, 5)
  assert.equal(shipFull.json.items[0].lot_id, rl.lot_id) // truy vết đúng lô GĐ1
  atPick2 = (await balGd1()).find((b) => b.location_id === pickLoc.id)
  assert.equal(atPick2.available, 2)
  console.log('✓ GĐ2 ship: phiếu giao kèm lô gốc, đơn COMPLETED, khả dụng vẫn 2')

  const ret = await call('POST', `/api/shipments/${ship.json.shipment_id}/returns`, {
    token, device, body: { lines: [{ shipment_item_id: shipFull.json.items[0].id, qty: 2, reason: 'Khách đổi ý' }] },
  })
  assert.equal(ret.status, 201, JSON.stringify(ret.json))
  assert.match(ret.json.return_no, /^TH-\d{4}$/)
  let atRecv2 = (await balGd1()).find((b) => b.location_id === recvLoc.id)
  assert.deepEqual([atRecv2.on_hand, atRecv2.inspect, atRecv2.damaged], [3, 2, 1])
  console.log('✓ GĐ2 trả hàng: 2 về xô inspect tại khu nhận, đúng lô gốc')

  const rets = await call('GET', '/api/returns', { token, device })
  const retLine = rets.json.returns[0].lines[0]
  assert.equal(retLine.lot_id, rl.lot_id)
  const retQc = await call('POST', `/api/returns/${ret.json.return_id}/qc`, {
    token, device, body: { return_line_id: retLine.id, qty_pass: 2, qty_fail: 0 },
  })
  assert.equal(retQc.status, 200, JSON.stringify(retQc.json))
  const retPut = await call('POST', `/api/returns/${ret.json.return_id}/putaway`, {
    token, device, body: { return_line_id: retLine.id, qty: 2, to_location_id: pickLoc.id },
  })
  assert.equal(retPut.status, 200, JSON.stringify(retPut.json))
  atPick2 = (await balGd1()).find((b) => b.location_id === pickLoc.id)
  assert.deepEqual([atPick2.on_hand, atPick2.available], [4, 4])
  const retsAfter = await call('GET', '/api/returns', { token, device })
  assert.equal(retsAfter.json.returns[0].status, 'DONE')
  console.log('✓ GĐ2 QC + putaway hàng trả: khả dụng A01-01 = 4, phiếu trả DONE')

  // --- GĐ3: freeze -> allocation bị chặn một phần -> move -> kiểm kê quay vòng
  // (expected/on_hand = 3 tại A01-01 sau freeze+move) -> đếm thiếu 1 -> duyệt áp
  // -> transfer liên kho -> policy min/max -> PO nháp -> alerts hết hạn/tồn thấp ---
  // Số tồn bắt đầu đoạn GĐ3 (cuối GĐ2): GD1-1 tại A01-01 on_hand=4, available=4; A01-02 trống.
  const whId = atPick2.warehouse_id
  const lotId = rl.lot_id
  const balSku = async () => (await call('GET', '/api/inventory/balances?sku=GD1-1', { token, device })).json.balances
  const atLoc = async (locId) => (await balSku()).find((b) => b.location_id === locId)

  const freeze = await call('POST', '/api/inventory/freeze', {
    token, device, body: { sku: 'GD1-1', lot_id: lotId, location_id: pickLoc.id, warehouse_id: whId, qty: 1, reason_code: 'QUALITY_HOLD' },
  })
  assert.equal(freeze.status, 201, JSON.stringify(freeze.json))
  let bA = await atLoc(pickLoc.id)
  assert.deepEqual([bA.on_hand, bA.hold, bA.available], [4, 1, 3])
  const frozenList = await call('GET', '/api/inventory/frozen', { token, device })
  assert.equal(frozenList.json.frozen.length, 1)
  assert.equal(frozenList.json.frozen[0].reason_code, 'QUALITY_HOLD')
  console.log('✓ GĐ3 đóng băng 1: on_hand=4, hold=1, khả dụng còn 3')

  // Hàng đóng băng bị loại khỏi allocation: đơn 4 chỉ phân bổ được 3, backorder 1.
  const ob2 = await call('POST', '/api/outbound-orders', {
    token, device, body: { customer_name: 'Khách khói 2', lines: [{ sku: 'GD1-1', qty_ordered: 4 }] },
  })
  assert.equal(ob2.status, 201, JSON.stringify(ob2.json))
  const alloc2 = await call('POST', `/api/outbound-orders/${ob2.json.id}/allocate`, { token, device, body: {} })
  assert.equal(alloc2.json.results[0].qty_allocated, 3)
  assert.equal(alloc2.json.results[0].backorder, 1)
  const cancel2 = await call('POST', `/api/outbound-orders/${ob2.json.id}/cancel`, { token, device, body: {} })
  assert.equal(cancel2.status, 200)
  bA = await atLoc(pickLoc.id)
  assert.deepEqual([bA.allocated, bA.available], [0, 3])
  console.log('✓ GĐ3 allocation: đơn 4 chỉ giữ được 3 (1 đang băng), huỷ đơn nhả hết giữ chỗ')

  const locs2 = await call('GET', '/api/locations', { token, device })
  const pickLoc2 = locs2.json.locations.find((l) => l.code === 'A01-02')
  assert.ok(pickLoc2)
  const move = await call('POST', '/api/inventory/move', {
    token, device,
    body: { sku: 'GD1-1', lot_id: lotId, warehouse_id: whId, from_location_id: pickLoc.id, to_location_id: pickLoc2.id, qty: 1 },
  })
  assert.equal(move.status, 201, JSON.stringify(move.json))
  bA = await atLoc(pickLoc.id)
  const bB = await atLoc(pickLoc2.id)
  // A01-01: on_hand 4-1(move) = 3 (gồm 1 đang băng), khả dụng 3-1(băng) = 2. A01-02: on_hand 1.
  assert.deepEqual([bA.on_hand, bA.hold, bA.available], [3, 1, 2])
  assert.deepEqual([bB.on_hand, bB.available], [1, 1])
  console.log('✓ GĐ3 move 1 sang A01-02: A01-01 on_hand=3 (băng 1), A01-02 on_hand=1')

  // Kiểm kê tại A01-01: expected = on_hand vật lý = 3 (kể cả phần đang băng);
  // hold_qty snapshot riêng = 1, không tính chênh lệch. Đếm thực tế 2 -> thiếu 1.
  const cc = await call('POST', '/api/cycle-counts', {
    token, device, body: { scope_type: 'LOCATION', location_id: pickLoc.id },
  })
  assert.equal(cc.status, 201, JSON.stringify(cc.json))
  assert.match(cc.json.count_no, /^CC-\d{4}$/)
  assert.equal(cc.json.task_count, 1)
  const ccFull = await call('GET', `/api/cycle-counts/${cc.json.id}`, { token, device })
  const ccTask = ccFull.json.tasks[0]
  assert.deepEqual([ccTask.expected_qty, ccTask.hold_qty, ccTask.inspect_qty], [3, 1, 0])
  const ccCount = await call('POST', `/api/cycle-counts/${cc.json.id}/count`, {
    token, device, body: { entries: [{ task_id: ccTask.id, counted_qty: 2 }] },
  })
  assert.equal(ccCount.json.status, 'COUNTED')
  const ccApprove = await call('POST', `/api/cycle-counts/${cc.json.id}/approve`, { token, device, body: {} })
  assert.equal(ccApprove.status, 200, JSON.stringify(ccApprove.json))
  assert.equal(ccApprove.json.status, 'APPLIED')
  assert.equal(ccApprove.json.movements, 1) // 1 movement ADJUST_OUT với reason COUNT_VARIANCE
  bA = await atLoc(pickLoc.id)
  // Sau áp chênh lệch: on_hand 3-1 = 2, hold vẫn 1, khả dụng 2-1 = 1.
  assert.deepEqual([bA.on_hand, bA.hold, bA.available], [2, 1, 1])
  console.log('✓ GĐ3 kiểm kê: expected=3, đếm 2 -> ADJUST_OUT 1 -> on_hand=2, khả dụng=1')

  const unfreeze = await call('POST', '/api/inventory/unfreeze', {
    token, device, body: { sku: 'GD1-1', lot_id: lotId, location_id: pickLoc.id, warehouse_id: whId, qty: 1 },
  })
  assert.equal(unfreeze.status, 201, JSON.stringify(unfreeze.json))
  bA = await atLoc(pickLoc.id)
  assert.deepEqual([bA.on_hand, bA.hold, bA.available], [2, 0, 2])
  console.log('✓ GĐ3 mở băng: khả dụng A01-01 về 2')

  // Chuyển kho: tạo kho đích WH2 + vị trí B01-01, chuyển 1 từ A01-02 sang.
  const wh2 = await call('POST', '/api/warehouses', { token, device, body: { code: 'WH2', name: 'Kho 2 khói' } })
  assert.equal(wh2.status, 201, JSON.stringify(wh2.json))
  const locB = await call('POST', '/api/locations', {
    token, device, body: { warehouse_id: wh2.json.id, code: 'B01-01', loc_type: 'PICKABLE', pick_sequence: 101 },
  })
  assert.equal(locB.status, 201, JSON.stringify(locB.json))
  const tr = await call('POST', '/api/transfer-orders', {
    token, device,
    body: {
      from_warehouse_id: whId, to_warehouse_id: wh2.json.id,
      lines: [{ sku: 'GD1-1', lot_id: lotId, from_location_id: pickLoc2.id, to_location_id: locB.json.id, qty: 1 }],
    },
  })
  assert.equal(tr.status, 201, JSON.stringify(tr.json))
  assert.match(tr.json.transfer_no, /^CK-\d{4}$/)
  const trShip = await call('POST', `/api/transfer-orders/${tr.json.id}/ship`, { token, device, body: {} })
  assert.equal(trShip.json.status, 'IN_TRANSIT')
  let bFrom = await atLoc(pickLoc2.id)
  assert.deepEqual([bFrom.on_hand, bFrom.in_transit], [0, 1])
  const trRecv = await call('POST', `/api/transfer-orders/${tr.json.id}/receive`, { token, device, body: {} })
  assert.equal(trRecv.json.status, 'DONE')
  bFrom = await atLoc(pickLoc2.id)
  const bDest = (await balSku()).find((b) => b.location_id === locB.json.id)
  assert.deepEqual([bFrom.on_hand, bFrom.in_transit], [0, 0])
  assert.deepEqual([bDest.on_hand, bDest.available], [1, 1])
  console.log('✓ GĐ3 chuyển kho: xuất -> in_transit=1 -> nhận kho đích on_hand=1, phiếu DONE')

  // Policy min 5 / max 10 cho kho chính: khả dụng (kho chính) = 2 < min 5.
  // Đang đặt (on_order) của PO-0001 PARTIAL = 10 - 8 = 2 -> gợi ý = 10 - 2 - 2 = 6.
  const pol = await call('PUT', '/api/stock-policies', {
    token, device, body: { sku: 'GD1-1', warehouse_id: whId, min_qty: 5, max_qty: 10 },
  })
  assert.equal(pol.status, 201, JSON.stringify(pol.json))
  const sugg = await call('GET', '/api/replenishment/suggestions', { token, device })
  const suggGd1 = sugg.json.suggestions.find((x) => x.sku === 'GD1-1')
  assert.ok(suggGd1, 'phải có gợi ý cho GD1-1')
  assert.deepEqual([suggGd1.available, suggGd1.on_order, suggGd1.suggested_qty], [2, 2, 6])
  console.log('✓ GĐ3 gợi ý đặt hàng: available=2, on_order=2 -> suggested=6 (max 10)')

  const sup = await call('POST', '/api/suppliers', { token, device, body: { code: 'SUP-SMOKE', name: 'NCC Khói' } })
  assert.equal(sup.status, 201, JSON.stringify(sup.json))
  const setSup = await call('PUT', '/api/products/default-supplier', {
    token, device, body: { sku: 'GD1-1', supplier_id: sup.json.id },
  })
  assert.equal(setSup.status, 200, JSON.stringify(setSup.json))
  const createdPos = await call('POST', '/api/replenishment/create-pos', { token, device, body: {} })
  assert.equal(createdPos.status, 201, JSON.stringify(createdPos.json))
  assert.equal(createdPos.json.created.length, 1)
  const draftPo = await call('GET', `/api/purchase-orders?status=DRAFT`, { token, device })
  const draft = draftPo.json.purchase_orders.find((x) => x.po_no === createdPos.json.created[0].po_no)
  assert.ok(draft && draft.status === 'DRAFT')
  const draftFull = await call('GET', `/api/purchase-orders/${draft.id}`, { token, device })
  assert.equal(draftFull.json.lines[0].qty_ordered, 6)
  console.log('✓ GĐ3 tạo PO nháp từ gợi ý: DRAFT với dòng đặt 6')

  // Lô sắp hết hạn (+5 ngày) qua luồng nhận GĐ1 để quét cảnh báo.
  const expDate = new Date(Date.now() + 5 * 86400000)
  const ep = (n) => String(n).padStart(2, '0')
  const expStr = `${expDate.getFullYear()}-${ep(expDate.getMonth() + 1)}-${ep(expDate.getDate())}`
  const po3 = await call('POST', '/api/purchase-orders', {
    token, device, body: { lines: [{ sku: 'GD3-EXP', description: 'Hàng sắp hết hạn', qty_ordered: 3, unit_price: 500 }] },
  })
  assert.equal(po3.status, 201, JSON.stringify(po3.json))
  await call('POST', `/api/purchase-orders/${po3.json.id}/transition`, { token, device, body: { to: 'SENT' } })
  const po3Full0 = await call('GET', `/api/purchase-orders/${po3.json.id}`, { token, device })
  const rcv3 = await call('POST', `/api/purchase-orders/${po3.json.id}/receive`, {
    token, device,
    body: { lines: [{ po_line_id: po3Full0.json.lines[0].id, qty_received: 3, expiry_date: expStr }] },
  })
  assert.equal(rcv3.status, 201, JSON.stringify(rcv3.json))
  const po3Full = await call('GET', `/api/purchase-orders/${po3.json.id}`, { token, device })
  const rl3 = po3Full.json.receipts[0].lines[0]
  const qc3 = await call('POST', `/api/receipts/${rcv3.json.receipt_id}/qc`, {
    token, device, body: { receipt_line_id: rl3.id, qty_pass: 3, qty_fail: 0 },
  })
  assert.equal(qc3.status, 200, JSON.stringify(qc3.json))
  const put3 = await call('POST', `/api/receipts/${rcv3.json.receipt_id}/putaway`, {
    token, device, body: { receipt_line_id: rl3.id, qty: 3, to_location_id: pickLoc.id },
  })
  assert.equal(put3.status, 200, JSON.stringify(put3.json))

  const scan = await call('POST', '/api/alerts/scan', { token, device, body: {} })
  assert.equal(scan.status, 200, JSON.stringify(scan.json))
  const alertsRes = await call('GET', '/api/alerts', { token, device })
  const expAlert = alertsRes.json.alerts.find((a) => a.type === 'EXPIRY_7' && a.sku === 'GD3-EXP')
  assert.ok(expAlert, 'phải có cảnh báo EXPIRY_7 cho lô +5 ngày')
  assert.equal(expAlert.severity, 'CRITICAL')
  const lowAlert = alertsRes.json.alerts.find((a) => a.type === 'LOW_STOCK' && a.sku === 'GD1-1')
  assert.ok(lowAlert, 'phải có cảnh báo LOW_STOCK cho GD1-1 (khả dụng 2 < min 5)')
  assert.equal(lowAlert.severity, 'WARN')
  const ack = await call('POST', `/api/alerts/${lowAlert.id}/ack`, { token, device, body: {} })
  assert.equal(ack.json.status, 'ACK')
  console.log('✓ GĐ3 cảnh báo: EXPIRY_7 CRITICAL (lô +5 ngày) + LOW_STOCK WARN, ACK được')

  const backup = await call('POST', '/api/admin/backup', { token })
  assert.equal(backup.status, 200)
  assert.ok(fs.existsSync(path.join(tmp, 'backups', backup.json.file)), 'file backup phải tồn tại')
  console.log('✓ backup tạo file trong data/backups/')

  console.log('\nSMOKE TEST PASS')
} finally {
  child.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}
