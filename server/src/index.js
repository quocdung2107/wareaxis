// Warehouse Server — máy chủ kho localhost (GĐ-LAN, kế hoạch v2 Phần 4B).
// Zero-dependency: Node thuần (node:http + node:sqlite + node:crypto), ESM, chạy ngay
// không cần build: `npm run server`. Dữ liệu tồn kho CHỈ nằm trong file SQLite của
// server này tại kho — không gửi đi đâu, không dùng Supabase cho tồn kho.
//
// Logic tồn kho ở đây cài lại (port) từ src/domain/ledger/apply.ts và ma trận quyền
// từ src/domain/permissions/ — sửa logic ở domain thì phải sửa tương ứng ở đây
// (hai nơi được giữ khớp bằng tests/ledger.test.ts + server/test-smoke.mjs).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url)) // server/src
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..')
const PORT = Number(process.env.WMS_PORT || 8787)
const DATA_DIR = process.env.WMS_DATA_DIR || path.join(SERVER_DIR, '..', 'data')
const DB_PATH = process.env.WMS_DB_PATH || path.join(DATA_DIR, 'warehouse.db')
const DIST_DIR = path.join(REPO_ROOT, 'dist')
const WAREHOUSE_CODE = process.env.WMS_WAREHOUSE_CODE || 'KHO-01'
const FEDERATION_KEY = process.env.WMS_FEDERATION_KEY || ''
const ADMIN_USER = process.env.WMS_ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.WMS_ADMIN_PASS || 'doi-mat-khau-ngay'
const USING_DEFAULT_PASS = !process.env.WMS_ADMIN_PASS
const VERSION = 'wms-v2-lan-1'

// ---------- DB ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

// Schema tương đương phần GĐ0 trong src/shared/inventory/repo.ts (chỉ các bảng server cần).
db.exec(`
CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, address TEXT, is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, code TEXT NOT NULL, name TEXT, zone_type TEXT, UNIQUE (warehouse_id, code));
CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, zone_id INTEGER, code TEXT NOT NULL, barcode TEXT UNIQUE, loc_type TEXT, capacity_qty REAL, pick_sequence INTEGER, active INTEGER NOT NULL DEFAULT 1, UNIQUE (warehouse_id, code));
CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT, tax_code TEXT, lead_time_days INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement_no TEXT UNIQUE, type TEXT NOT NULL,
  warehouse_id INTEGER, location_id INTEGER, from_location_id INTEGER, lot_id INTEGER, sku TEXT NOT NULL, qty REAL NOT NULL,
  qty_before REAL, qty_after REAL, doc_type TEXT, doc_id INTEGER, doc_line_id INTEGER, reason_code TEXT, note TEXT,
  actor TEXT, reverses_movement_id INTEGER, period INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_mv_sku_at ON stock_movements(sku, created_at);
CREATE INDEX IF NOT EXISTS idx_mv_lot ON stock_movements(lot_id);
CREATE TABLE IF NOT EXISTS stock_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, location_id INTEGER, lot_id INTEGER, sku TEXT NOT NULL,
  on_hand REAL NOT NULL DEFAULT 0, allocated REAL NOT NULL DEFAULT 0, hold REAL NOT NULL DEFAULT 0,
  damaged REAL NOT NULL DEFAULT 0, inspect REAL NOT NULL DEFAULT 0, in_transit REAL NOT NULL DEFAULT 0, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_bal_sku ON stock_balances(sku);
CREATE TABLE IF NOT EXISTS stock_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, sku TEXT NOT NULL, min_qty REAL, max_qty REAL, reorder_point REAL, reorder_qty REAL, count_class TEXT, UNIQUE (warehouse_id, sku));
CREATE TABLE IF NOT EXISTS adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS local_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_name TEXT, user_id INTEGER, token_hash TEXT, status TEXT NOT NULL DEFAULT 'PENDING', last_seen_at TEXT, approved_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, device_id INTEGER, token_hash TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE TABLE IF NOT EXISTS federation_peers (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_code TEXT UNIQUE, warehouse_name TEXT, base_url TEXT, api_key_hash TEXT, share_policy TEXT, active INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT);
CREATE TABLE IF NOT EXISTS federation_query_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, peer_warehouse_code TEXT, query_type TEXT, sku TEXT, requested_by TEXT, result_status TEXT, created_at TEXT);
`)

const REASONS = [
  ['COUNT_VARIANCE', 'Chênh lệch kiểm kê', 1], ['DAMAGED', 'Hàng hỏng / vỡ', 0],
  ['EXPIRED', 'Hết hạn dùng', 0], ['LOST', 'Thất lạc / mất hàng', 1],
  ['FOUND', 'Tìm thấy hàng (tăng tồn)', 1], ['INPUT_ERROR', 'Sai sót nhập liệu', 0],
  ['RETURN_QC', 'Hàng trả không đạt kiểm tra', 0],
]
const insReason = db.prepare('INSERT OR IGNORE INTO adjustment_reasons (code, name, requires_approval) VALUES (?, ?, ?)')
for (const r of REASONS) insReason.run(...r)

// ---------- Auth: scrypt + token phiên ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
function hashPassword(pass) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(pass, salt, 64)
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`
}
function verifyPassword(pass, stored) {
  try {
    const [, saltHex, hashHex] = String(stored).split(':')
    const expect = Buffer.from(hashHex, 'hex')
    const got = crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), 64)
    return expect.length === got.length && crypto.timingSafeEqual(expect, got)
  } catch { return false }
}
const nowStamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Seed admin đầu tiên (chỉ khi chưa có user nào). Không có đăng ký tự do,
// không có đường tự nâng quyền — tạo thêm user là việc của admin (GĐ sau có UI).
{
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM local_users').get()
  if (n === 0) {
    db.prepare('INSERT INTO local_users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ADMIN_USER, hashPassword(ADMIN_PASS), 'Quản trị kho', 'KHO_ADMIN', nowStamp())
    console.log(`[seed] Đã tạo tài khoản quản trị đầu tiên: ${ADMIN_USER}`)
    if (USING_DEFAULT_PASS) console.log('[seed] CẢNH BÁO: đang dùng mật khẩu mặc định — đổi ngay bằng biến WMS_ADMIN_PASS trước khi dùng thật!')
  }
}

// ---------- Phân quyền (port từ src/domain/permissions/roles.ts + guard.ts) ----------
const PERMISSIONS = ['inventory_view', 'inventory_receive', 'inventory_putaway', 'inventory_pick', 'inventory_count',
  'inventory_adjust', 'inventory_transfer', 'purchase_create', 'reports_view', 'users_manage', 'devices_manage',
  'backup_manage', 'federation_manage']
const ROLE_PERMISSIONS = {
  KHO_ADMIN: PERMISSIONS,
  THU_KHO: ['inventory_view', 'inventory_receive', 'inventory_putaway', 'inventory_pick', 'inventory_count', 'inventory_adjust', 'inventory_transfer', 'purchase_create', 'reports_view'],
  NV_LAY_HANG: ['inventory_view', 'inventory_pick'],
  NV_NHAN_HANG: ['inventory_view', 'inventory_receive', 'inventory_putaway'],
  KE_TOAN_XEM: ['inventory_view', 'reports_view'],
}
const can = (role, perm) => (ROLE_PERMISSIONS[role] || []).includes(perm)
function permissionForMovement(type) {
  switch (type) {
    case 'RECEIVE': case 'RETURN_IN': return 'inventory_receive'
    case 'PUTAWAY': return 'inventory_putaway'
    case 'ALLOCATE': case 'DEALLOCATE': case 'PICK': return 'inventory_pick'
    case 'MOVE': case 'TRANSFER_OUT': case 'TRANSFER_IN': return 'inventory_transfer'
    default: return 'inventory_adjust'
  }
}

// ---------- Ledger (port từ src/domain/ledger/apply.ts) ----------
const REASON_REQUIRED = new Set(['ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'WRITE_OFF'])
const REASON_CODES = new Set(REASONS.map((r) => r[0]))
const EPS = 1e-9
const r6 = (n) => Math.round(n * 1e6) / 1e6
const availableOf = (b) => r6(b.on_hand - b.allocated - b.hold - b.damaged - b.inspect)
function validateMovement(m) {
  if (!m.sku || !String(m.sku).trim()) throw new Error('Movement thiếu SKU')
  if (!Number.isFinite(m.qty) || m.qty <= 0) throw new Error(`Movement ${m.type}: số lượng phải lớn hơn 0`)
  if (REASON_REQUIRED.has(m.type)) {
    if (!m.reason_code) throw new Error(`Movement ${m.type} bắt buộc có lý do (reason_code)`)
    if (!REASON_CODES.has(m.reason_code)) throw new Error(`Lý do không có trong danh mục: ${m.reason_code}`)
  }
  if (m.type === 'REVERSAL' && m.reverses_movement_id == null) throw new Error('REVERSAL bắt buộc có reverses_movement_id')
}
function assertNonNegative(b, type) {
  for (const k of ['on_hand', 'allocated', 'hold', 'damaged', 'inspect', 'in_transit']) {
    if (b[k] < -EPS) throw new Error(`Movement ${type} làm xô ${k} âm (${b[k]})`)
  }
  if (availableOf(b) < -EPS) throw new Error(`Movement ${type} làm tồn khả dụng âm`)
}
function applyToBalance(cur, m) {
  const b = { ...cur }
  const q = m.qty
  switch (m.type) {
    case 'RECEIVE': case 'RETURN_IN': case 'ADJUST_IN': b.on_hand += q; break
    case 'PUTAWAY': b.inspect -= q; break
    case 'ALLOCATE': b.allocated += q; break
    case 'DEALLOCATE': b.allocated -= q; break
    case 'FREEZE': b.hold += q; break
    case 'UNFREEZE': b.hold -= q; break
    case 'DAMAGE': b.damaged += q; break
    case 'TRANSFER_OUT': b.on_hand -= q; b.in_transit += q; break
    case 'TRANSFER_IN': b.in_transit -= q; b.on_hand += q; break
    case 'ADJUST_OUT': b.on_hand -= q; break
    case 'PICK': {
      if (b.on_hand + EPS < q) throw new Error('PICK vượt tồn vật lý')
      b.allocated -= Math.min(b.allocated, q); b.on_hand -= q; break
    }
    case 'WRITE_OFF': {
      if (b.on_hand + EPS < q) throw new Error('WRITE_OFF vượt tồn vật lý')
      b.damaged -= Math.min(b.damaged, q); b.on_hand -= q; break
    }
    case 'MOVE': case 'REVERSAL':
      throw new Error(`${m.type} chưa hỗ trợ qua API ở bản GĐ-LAN (MOVE hai phía / REVERSAL làm ở GĐ sau)`)
    default: throw new Error(`Loại movement không rõ: ${m.type}`)
  }
  for (const k of Object.keys(b)) b[k] = r6(b[k])
  assertNonNegative(b, m.type)
  return b
}
const emptyBalance = (m, locationId) => ({
  warehouse_id: m.warehouse_id ?? null, location_id: locationId, lot_id: m.lot_id ?? null, sku: String(m.sku),
  on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0,
})
function findBalance(m, locationId) {
  return db.prepare(`SELECT * FROM stock_balances WHERE warehouse_id IS ? AND location_id IS ? AND lot_id IS ?
    AND UPPER(TRIM(sku)) = UPPER(TRIM(?))`).get(m.warehouse_id ?? null, locationId, m.lot_id ?? null, String(m.sku))
}
function saveBalance(row, b, at) {
  if (row) {
    db.prepare('UPDATE stock_balances SET on_hand=?, allocated=?, hold=?, damaged=?, inspect=?, in_transit=?, updated_at=? WHERE id=?')
      .run(b.on_hand, b.allocated, b.hold, b.damaged, b.inspect, b.in_transit, at, row.id)
  } else {
    db.prepare(`INSERT INTO stock_balances (warehouse_id, location_id, lot_id, sku, on_hand, allocated, hold, damaged, inspect, in_transit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.warehouse_id, b.location_id, b.lot_id, b.sku, b.on_hand, b.allocated, b.hold, b.damaged, b.inspect, b.in_transit, at)
  }
}
/** Áp movement trong transaction BEGIN IMMEDIATE: hoặc ghi cả movement + balance, hoặc không gì cả. */
function applyMovementTxn(m, actor) {
  validateMovement(m)
  const at = nowStamp()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = findBalance(m, m.location_id ?? null)
    const cur = row ? { on_hand: row.on_hand, allocated: row.allocated, hold: row.hold, damaged: row.damaged, inspect: row.inspect, in_transit: row.in_transit } : { on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 }
    const next = applyToBalance(cur, m)
    const info = db.prepare(`INSERT INTO stock_movements (movement_no, type, warehouse_id, location_id, from_location_id, lot_id, sku, qty,
      qty_before, qty_after, doc_type, doc_id, doc_line_id, reason_code, note, actor, reverses_movement_id, period, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.movement_no ?? null, m.type, m.warehouse_id ?? null, m.location_id ?? null, m.from_location_id ?? null,
        m.lot_id ?? null, String(m.sku), m.qty, cur.on_hand, next.on_hand, m.doc_type ?? null, m.doc_id ?? null,
        m.doc_line_id ?? null, m.reason_code ?? null, m.note ?? null, actor, m.reverses_movement_id ?? null, m.period ?? null, at)
    saveBalance(row, { ...emptyBalance(m, m.location_id ?? null), ...next }, at)
    db.exec('COMMIT')
    return { id: Number(info.lastInsertRowid), balance: { ...emptyBalance(m, m.location_id ?? null), ...next, available: availableOf(next) } }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---------- HTTP helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('Body quá lớn'))
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) } catch { reject(new Error('JSON không hợp lệ')) }
    })
    req.on('error', reject)
  })
}
function getSession(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) return null
  const s = db.prepare(`SELECT s.*, u.username, u.role, u.active FROM sessions s JOIN local_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL`).get(sha256(m[1]))
  if (!s || !s.active) return null
  if (s.expires_at && s.expires_at < nowStamp()) return null
  return s
}
/** Kiểm thiết bị đã duyệt cho API nghiệp vụ: header x-device-id + x-device-token. */
function checkDevice(req) {
  const id = Number(req.headers['x-device-id'])
  const token = req.headers['x-device-token']
  if (!id || !token) return { ok: false, error: 'missing_device', message: 'Thiếu x-device-id / x-device-token' }
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id)
  if (!d) return { ok: false, error: 'device_not_found', message: 'Không tìm thấy thiết bị' }
  if (d.status !== 'APPROVED') return { ok: false, error: 'device_not_approved', message: `Thiết bị đang ở trạng thái ${d.status}` }
  if (d.token_hash !== sha256(String(token))) return { ok: false, error: 'device_token_invalid', message: 'Mã thiết bị không đúng' }
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowStamp(), id)
  return { ok: true, device: d }
}
function requireAuth(req, res) {
  const s = getSession(req)
  if (!s) { sendJson(res, 401, { error: 'unauthorized', message: 'Chưa đăng nhập hoặc phiên hết hạn' }); return null }
  return s
}
function requireDevice(req, res) {
  const d = checkDevice(req)
  if (!d.ok) { sendJson(res, 403, { error: d.error, message: d.message }); return null }
  return d.device
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname
  try {
    // --- Health ---
    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, warehouse_code: WAREHOUSE_CODE, version: VERSION, time: nowStamp() })
    }

    // --- Federation (chỉ đọc, Phần 4B.4) ---
    if (p === '/federation/v1/ping' && req.method === 'GET') {
      return sendJson(res, 200, { warehouse_code: WAREHOUSE_CODE, name: WAREHOUSE_CODE, server_time: nowStamp(), version: VERSION })
    }
    if (p === '/federation/v1/inventory/availability' && req.method === 'GET') {
      const peer = String(req.headers['x-federation-peer'] || 'unknown')
      const sku = url.searchParams.get('sku') || url.searchParams.get('q') || ''
      if (!FEDERATION_KEY) {
        db.prepare('INSERT INTO federation_query_logs (peer_warehouse_code, query_type, sku, requested_by, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(peer, 'availability', sku, peer, 'not_configured', nowStamp())
        return sendJson(res, 503, { error: 'federation_not_configured', message: 'Kho này chưa đặt WMS_FEDERATION_KEY' })
      }
      const given = Buffer.from(String(req.headers['x-federation-key'] || ''))
      const expect = Buffer.from(FEDERATION_KEY)
      if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) {
        db.prepare('INSERT INTO federation_query_logs (peer_warehouse_code, query_type, sku, requested_by, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(peer, 'availability', sku, peer, 'forbidden', nowStamp())
        return sendJson(res, 403, { error: 'forbidden', message: 'Khoá liên kho không đúng' })
      }
      const rows = sku
        ? db.prepare('SELECT * FROM stock_balances WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY location_id, lot_id').all(sku)
        : db.prepare('SELECT * FROM stock_balances ORDER BY sku, location_id, lot_id').all()
      const balances = rows.map((r) => ({
        sku: r.sku, lot_id: r.lot_id, location_id: r.location_id, on_hand: r.on_hand, allocated: r.allocated,
        hold: r.hold, damaged: r.damaged, inspect: r.inspect, in_transit: r.in_transit, available: availableOf(r),
      }))
      db.prepare('INSERT INTO federation_query_logs (peer_warehouse_code, query_type, sku, requested_by, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(peer, 'availability', sku, peer, 'ok', nowStamp())
      // Chỉ chia sẻ số lượng tồn — KHÔNG giá vốn, KHÔNG nhà cung cấp, KHÔNG lịch sử biến động.
      return sendJson(res, 200, {
        warehouse_code: WAREHOUSE_CODE, sku: sku || null, balances,
        total_available: r6(balances.reduce((s, b) => s + b.available, 0)),
      })
    }

    // --- Auth ---
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req)
      const u = db.prepare('SELECT * FROM local_users WHERE username = ?').get(String(body.username || ''))
      if (!u || !u.active || !verifyPassword(String(body.password || ''), u.password_hash)) {
        return sendJson(res, 401, { error: 'invalid_credentials', message: 'Sai tên đăng nhập hoặc mật khẩu' })
      }
      const token = crypto.randomBytes(32).toString('hex')
      const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000)
      const ep = (n) => String(n).padStart(2, '0')
      const expiresStr = `${expires.getFullYear()}-${ep(expires.getMonth() + 1)}-${ep(expires.getDate())} ${ep(expires.getHours())}:${ep(expires.getMinutes())}:${ep(expires.getSeconds())}`
      db.prepare('INSERT INTO sessions (user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(u.id, body.device_id ?? null, sha256(token), expiresStr, nowStamp())
      db.prepare('UPDATE local_users SET last_login_at = ? WHERE id = ?').run(nowStamp(), u.id)
      return sendJson(res, 200, { token, user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }, expires_at: expiresStr })
    }

    // --- Devices (quản trị: cần đăng nhập + quyền devices_manage; chưa cần thiết bị duyệt) ---
    if (p === '/api/devices/register' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      const body = await readBody(req)
      const deviceToken = crypto.randomBytes(24).toString('hex')
      const info = db.prepare('INSERT INTO devices (device_name, user_id, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(String(body.device_name || 'Điện thoại'), s.user_id, sha256(deviceToken), 'PENDING', nowStamp())
      // device_token chỉ trả MỘT lần này; máy chủ chỉ lưu hash.
      return sendJson(res, 201, { id: Number(info.lastInsertRowid), status: 'PENDING', device_token: deviceToken })
    }
    if (p === '/api/devices' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!can(s.role, 'devices_manage')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền devices_manage' })
      const rows = db.prepare('SELECT id, device_name, user_id, status, last_seen_at, approved_by, created_at FROM devices ORDER BY id').all()
      return sendJson(res, 200, { devices: rows })
    }
    const devAction = /^\/api\/devices\/(\d+)\/(approve|revoke)$/.exec(p)
    if (devAction && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!can(s.role, 'devices_manage')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền devices_manage' })
      const id = Number(devAction[1])
      const status = devAction[2] === 'approve' ? 'APPROVED' : 'REVOKED'
      const info = db.prepare('UPDATE devices SET status = ?, approved_by = ? WHERE id = ?').run(status, s.username, id)
      if (!info.changes) return sendJson(res, 404, { error: 'device_not_found' })
      if (status === 'REVOKED') db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(nowStamp(), id)
      return sendJson(res, 200, { id, status })
    }

    // --- Backup (admin) ---
    if (p === '/api/admin/backup' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!can(s.role, 'backup_manage')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền backup_manage' })
      const dir = path.join(DATA_DIR, 'backups')
      fs.mkdirSync(dir, { recursive: true })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const stamp = nowStamp().replace(/[: ]/g, '-')
      const file = `warehouse-${stamp}.db`
      fs.copyFileSync(DB_PATH, path.join(dir, file))
      return sendJson(res, 200, { file, path: `server/data/backups/${file}` })
    }

    // --- Inventory (nghiệp vụ: cần đăng nhập + thiết bị đã duyệt) ---
    if (p === '/api/inventory/balances' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const sku = url.searchParams.get('sku')
      const rows = sku
        ? db.prepare('SELECT * FROM stock_balances WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY location_id, lot_id').all(sku)
        : db.prepare('SELECT * FROM stock_balances ORDER BY sku, location_id, lot_id').all()
      return sendJson(res, 200, {
        balances: rows.map((r) => ({
          id: r.id, warehouse_id: r.warehouse_id, location_id: r.location_id, lot_id: r.lot_id, sku: r.sku,
          on_hand: r.on_hand, allocated: r.allocated, hold: r.hold, damaged: r.damaged, inspect: r.inspect,
          in_transit: r.in_transit, available: availableOf(r), updated_at: r.updated_at,
        })),
      })
    }
    if (p === '/api/inventory/movements' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const sku = url.searchParams.get('sku')
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)))
      const rows = sku
        ? db.prepare('SELECT * FROM stock_movements WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY id DESC LIMIT ?').all(sku, limit)
        : db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT ?').all(limit)
      return sendJson(res, 200, { movements: rows })
    }
    if (p === '/api/inventory/movements' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      const body = await readBody(req)
      const perm = permissionForMovement(String(body.type || ''))
      if (!can(s.role, perm)) return sendJson(res, 403, { error: 'forbidden', message: `Thiếu quyền ${perm}` })
      try {
        const out = applyMovementTxn(body, s.username)
        return sendJson(res, 201, out)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
    }

    if (p.startsWith('/api/') || p.startsWith('/federation/')) {
      return sendJson(res, 404, { error: 'not_found', message: `Không có endpoint ${req.method} ${p}` })
    }

    // --- Tĩnh: phục vụ bản build frontend (dist/) nếu có ---
    const filePath = path.join(DIST_DIR, p === '/' ? 'index.html' : p)
    if (filePath.startsWith(DIST_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' })
      return res.end(fs.readFileSync(filePath))
    }
    const indexHtml = path.join(DIST_DIR, 'index.html')
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(fs.readFileSync(indexHtml))
    }
    return sendJson(res, 404, { error: 'frontend_not_built', message: 'Chưa có bản build frontend (dist/). Chạy npm run build trước, hoặc dùng các API /api/*.' })
  } catch (e) {
    return sendJson(res, 500, { error: 'server_error', message: String(e.message || e) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces()
  const lan = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)
  console.log('=== Warehouse Server (WMS v2 — GĐ-LAN) ===')
  console.log(`Kho: ${WAREHOUSE_CODE} | DB: ${DB_PATH}`)
  console.log(`Trên máy này:  http://localhost:${PORT}`)
  for (const ip of lan) console.log(`Điện thoại cùng Wi-Fi mở:  http://${ip}:${PORT}`)
  console.log(`Tài khoản quản trị: ${ADMIN_USER}${USING_DEFAULT_PASS ? ' (mật khẩu MẶC ĐỊNH — đổi ngay bằng WMS_ADMIN_PASS!)' : ''}`)
  console.log(FEDERATION_KEY ? 'Liên kho (Federation): đã bật (có khoá).' : 'Liên kho (Federation): chưa bật (chưa đặt WMS_FEDERATION_KEY).')
  console.log('CẢNH BÁO: chỉ dùng trong mạng LAN của kho. KHÔNG mở cổng này ra Internet; liên kho đi qua VPN (Tailscale/WireGuard).')
})
