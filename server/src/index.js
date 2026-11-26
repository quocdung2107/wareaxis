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

// Schema GĐ1 (tương đương phần GĐ1 trong src/shared/inventory/repo.ts):
// products/lots/purchase_orders/po_lines/receipts/receipt_lines + bộ đếm.
// Hàng PO sống ở lots + stock_balances, KHÔNG vào tồn nạp file của client.
db.exec(`
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, name TEXT, category_id INTEGER, uom TEXT, barcode TEXT, track_lot INTEGER NOT NULL DEFAULT 0, track_expiry INTEGER NOT NULL DEFAULT 0, shelf_life_days INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE TABLE IF NOT EXISTS lots (lot_id INTEGER PRIMARY KEY, sku TEXT NOT NULL, product_id INTEGER, batch_no TEXT, lot_no TEXT, manuf_date TEXT, expiry_date TEXT, supplier_id INTEGER, purchase_price REAL, status TEXT NOT NULL DEFAULT 'INSPECT', source_po_id INTEGER, source_receipt_line_id INTEGER, location_id INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_lots_sku_expiry ON lots(sku, expiry_date);
CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status);
CREATE TABLE IF NOT EXISTS po_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO po_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS lot_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO lot_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, po_no TEXT UNIQUE NOT NULL, supplier_id INTEGER, warehouse_id INTEGER, expected_date TEXT, status TEXT NOT NULL DEFAULT 'DRAFT', total_amount REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT, updated_at TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE TABLE IF NOT EXISTS po_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, po_id INTEGER NOT NULL, product_id INTEGER, sku TEXT NOT NULL, description TEXT, uom TEXT, qty_ordered REAL NOT NULL, qty_received REAL NOT NULL DEFAULT 0, qty_damaged REAL NOT NULL DEFAULT 0, unit_price REAL, expected_batch TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT UNIQUE NOT NULL, po_id INTEGER, warehouse_id INTEGER, received_by TEXT, received_at TEXT, status TEXT NOT NULL DEFAULT 'QC_PENDING', created_at TEXT);
CREATE TABLE IF NOT EXISTS receipt_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL, po_line_id INTEGER, sku TEXT NOT NULL, qty_expected REAL NOT NULL DEFAULT 0, qty_received REAL NOT NULL DEFAULT 0, qty_good REAL NOT NULL DEFAULT 0, qty_damaged REAL NOT NULL DEFAULT 0, qty_shortage REAL NOT NULL DEFAULT 0, qty_more REAL NOT NULL DEFAULT 0, lot_id INTEGER, qc_status TEXT NOT NULL DEFAULT 'PENDING', qty_qc_pass REAL NOT NULL DEFAULT 0, qty_qc_fail REAL NOT NULL DEFAULT 0, qty_putaway REAL NOT NULL DEFAULT 0, damage_reason_code TEXT);
`)

// Schema GĐ2 (tương đương phần GĐ2 trong src/shared/inventory/repo.ts):
// outbound_orders/outbound_lines/allocations/waves/wave_orders/pick_tasks(+parts)/
// shipments/shipment_items/returns/return_lines + các bộ đếm XH/WV/GH/TH.
// Chỉ áp cho hàng ledger (lots/balances); Supabase Orders chỉ lưu tham chiếu text.
db.exec(`
CREATE TABLE IF NOT EXISTS ob_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO ob_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS wave_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO wave_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS shipment_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO shipment_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS return_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO return_counter (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS outbound_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL, source TEXT NOT NULL DEFAULT 'MANUAL', external_ref TEXT, customer_name TEXT, customer_code TEXT, warehouse_id INTEGER, status TEXT NOT NULL DEFAULT 'DRAFT', carrier_text TEXT, note TEXT, created_at TEXT, updated_at TEXT, created_by TEXT);
CREATE INDEX IF NOT EXISTS idx_ob_status ON outbound_orders(status);
CREATE TABLE IF NOT EXISTS outbound_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, sku TEXT NOT NULL, description TEXT, uom TEXT, qty_ordered REAL NOT NULL, qty_allocated REAL NOT NULL DEFAULT 0, qty_picked REAL NOT NULL DEFAULT 0, qty_packed REAL NOT NULL DEFAULT 0, qty_shipped REAL NOT NULL DEFAULT 0, note TEXT);
CREATE TABLE IF NOT EXISTS allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, order_line_id INTEGER NOT NULL, lot_id INTEGER, location_id INTEGER, sku TEXT NOT NULL, qty_allocated REAL NOT NULL, qty_picked REAL NOT NULL DEFAULT 0, qty_shipped REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT);
CREATE TABLE IF NOT EXISTS waves (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_no TEXT UNIQUE NOT NULL, warehouse_id INTEGER, status TEXT NOT NULL DEFAULT 'OPEN', carrier_text TEXT, cutoff TEXT, note TEXT, created_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS wave_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_id INTEGER NOT NULL, order_id INTEGER NOT NULL, UNIQUE (wave_id, order_id));
CREATE TABLE IF NOT EXISTS pick_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_id INTEGER, allocation_id INTEGER, order_id INTEGER, order_line_id INTEGER, location_id INTEGER, location_code TEXT, lot_id INTEGER, sku TEXT NOT NULL, qty_need REAL NOT NULL, qty_picked REAL NOT NULL DEFAULT 0, pick_sequence INTEGER, status TEXT NOT NULL DEFAULT 'PENDING', picked_by TEXT, picked_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS pick_task_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, allocation_id INTEGER NOT NULL, qty_covered REAL NOT NULL, UNIQUE (task_id, allocation_id));
CREATE TABLE IF NOT EXISTS shipments (id INTEGER PRIMARY KEY AUTOINCREMENT, shipment_no TEXT UNIQUE NOT NULL, order_id INTEGER NOT NULL, carrier_text TEXT, tracking_text TEXT, status TEXT NOT NULL DEFAULT 'SHIPPED', shipped_at TEXT, shipped_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS shipment_items (id INTEGER PRIMARY KEY AUTOINCREMENT, shipment_id INTEGER NOT NULL, order_id INTEGER, order_line_id INTEGER, allocation_id INTEGER, sku TEXT NOT NULL, lot_id INTEGER, location_id INTEGER, qty REAL NOT NULL, qty_returned REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS returns (id INTEGER PRIMARY KEY AUTOINCREMENT, return_no TEXT UNIQUE NOT NULL, shipment_id INTEGER, order_id INTEGER, customer_name TEXT, status TEXT NOT NULL DEFAULT 'RECEIVED', note TEXT, created_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS return_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL, shipment_item_id INTEGER, sku TEXT NOT NULL, lot_id INTEGER, qty_returned REAL NOT NULL, qty_qc_pass REAL NOT NULL DEFAULT 0, qty_qc_fail REAL NOT NULL DEFAULT 0, qty_putaway REAL NOT NULL DEFAULT 0, qc_status TEXT NOT NULL DEFAULT 'PENDING', reason TEXT, damage_reason_code TEXT);
`)
{
  const cols = db.prepare('PRAGMA table_info(stock_movements)').all().map((c) => c.name)
  if (!cols.includes('into_inspect')) db.exec('ALTER TABLE stock_movements ADD COLUMN into_inspect INTEGER NOT NULL DEFAULT 0')
  if (!cols.includes('from_inspect')) db.exec('ALTER TABLE stock_movements ADD COLUMN from_inspect INTEGER NOT NULL DEFAULT 0')
}

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

// Seed kho mặc định + khu + vị trí (GĐ1) — CHỈ khi chưa có kho nào, giống client.
{
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM warehouses').get()
  if (n === 0) {
    const at = nowStamp()
    const w = db.prepare('INSERT INTO warehouses (code, name, is_default, created_at, updated_at, created_by) VALUES (?, ?, 1, ?, ?, ?)')
      .run('MAIN', 'Kho chính', at, at, 'seed')
    const whId = Number(w.lastInsertRowid)
    const zr = db.prepare('INSERT INTO zones (warehouse_id, code, name, zone_type) VALUES (?, ?, ?, ?)')
      .run(whId, 'RECEIVING', 'Khu nhận hàng', 'RECEIVING')
    const zs = db.prepare('INSERT INTO zones (warehouse_id, code, name, zone_type) VALUES (?, ?, ?, ?)')
      .run(whId, 'STORAGE', 'Khu lưu trữ', 'STORAGE')
    const ins = db.prepare('INSERT INTO locations (warehouse_id, zone_id, code, loc_type, pick_sequence) VALUES (?, ?, ?, ?, ?)')
    ins.run(whId, Number(zr.lastInsertRowid), 'NHAN-01', 'RECEIVING', 1)
    ins.run(whId, Number(zs.lastInsertRowid), 'A01-01', 'PICKABLE', 101)
    ins.run(whId, Number(zs.lastInsertRowid), 'A01-02', 'PICKABLE', 102)
    console.log('[seed] Đã tạo kho chính + vị trí NHAN-01, A01-01, A01-02')
  }
}

// ---------- Phân quyền (port từ src/domain/permissions/roles.ts + guard.ts) ----------
// 'purchase_receive' bổ sung ở GĐ1 — nguồn: src/domain/permissions/roles.ts.
// 'outbound_*' + 'returns_receive' bổ sung ở GĐ2 — nguồn: src/domain/permissions/roles.ts.
const PERMISSIONS = ['inventory_view', 'inventory_receive', 'inventory_putaway', 'inventory_pick', 'inventory_count',
  'inventory_adjust', 'inventory_transfer', 'purchase_create', 'purchase_receive',
  'outbound_allocate', 'outbound_pick', 'outbound_pack', 'outbound_ship', 'returns_receive',
  'reports_view', 'users_manage', 'devices_manage',
  'backup_manage', 'federation_manage']
const ROLE_PERMISSIONS = {
  KHO_ADMIN: PERMISSIONS,
  THU_KHO: ['inventory_view', 'inventory_receive', 'inventory_putaway', 'inventory_pick', 'inventory_count', 'inventory_adjust', 'inventory_transfer', 'purchase_create', 'purchase_receive', 'outbound_allocate', 'outbound_pick', 'outbound_pack', 'outbound_ship', 'returns_receive', 'reports_view'],
  NV_LAY_HANG: ['inventory_view', 'inventory_pick', 'outbound_pick', 'outbound_pack'],
  NV_NHAN_HANG: ['inventory_view', 'inventory_receive', 'inventory_putaway', 'purchase_receive', 'returns_receive'],
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
    // GĐ1: RECEIVE/RETURN_IN có cờ into_inspect -> cộng cả on_hand lẫn inspect.
    case 'RECEIVE': case 'RETURN_IN':
      b.on_hand += q; if (m.into_inspect) b.inspect += q; break
    case 'ADJUST_IN': b.on_hand += q; break
    case 'PUTAWAY': b.inspect -= q; break
    case 'ALLOCATE': b.allocated += q; break
    case 'DEALLOCATE': b.allocated -= q; break
    case 'FREEZE': b.hold += q; break
    case 'UNFREEZE': b.hold -= q; break
    // GĐ1: DAMAGE có cờ from_inspect -> lấy từ xô inspect sang damaged.
    case 'DAMAGE': if (m.from_inspect) b.inspect -= q; b.damaged += q; break
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
const bucketsOf = (row) => row
  ? { on_hand: row.on_hand, allocated: row.allocated, hold: row.hold, damaged: row.damaged, inspect: row.inspect, in_transit: row.in_transit }
  : { on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0 }
/** Áp movement trong transaction BEGIN IMMEDIATE: hoặc ghi cả movement + balance, hoặc không gì cả. */
function applyMovementTxn(m, actor) {
  validateMovement(m)
  const at = nowStamp()
  db.exec('BEGIN IMMEDIATE')
  try {
    // GĐ1: PUTAWAY khác vị trí = hai phía: nguồn {on_hand-, inspect-}, đích {on_hand+}.
    const crossPutaway = m.type === 'PUTAWAY' && m.from_location_id != null && m.location_id != null
      && Number(m.from_location_id) !== Number(m.location_id)
    const insertMovement = (qtyBefore, qtyAfter) => db.prepare(`INSERT INTO stock_movements (movement_no, type, warehouse_id, location_id, from_location_id, lot_id, sku, qty,
      qty_before, qty_after, doc_type, doc_id, doc_line_id, reason_code, note, actor, reverses_movement_id, period, created_at, into_inspect, from_inspect)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.movement_no ?? null, m.type, m.warehouse_id ?? null, m.location_id ?? null, m.from_location_id ?? null,
        m.lot_id ?? null, String(m.sku), m.qty, qtyBefore, qtyAfter, m.doc_type ?? null, m.doc_id ?? null,
        m.doc_line_id ?? null, m.reason_code ?? null, m.note ?? null, actor, m.reverses_movement_id ?? null, m.period ?? null, at,
        m.into_inspect ? 1 : 0, m.from_inspect ? 1 : 0)
    if (crossPutaway) {
      const srcRow = findBalance(m, m.from_location_id)
      const srcCur = bucketsOf(srcRow)
      const srcNext = { ...srcCur, on_hand: r6(srcCur.on_hand - m.qty), inspect: r6(srcCur.inspect - m.qty) }
      assertNonNegative(srcNext, m.type)
      const dstRow = findBalance(m, m.location_id)
      const dstCur = bucketsOf(dstRow)
      const dstNext = { ...dstCur, on_hand: r6(dstCur.on_hand + m.qty) }
      assertNonNegative(dstNext, m.type)
      const info = insertMovement(dstCur.on_hand, dstNext.on_hand)
      saveBalance(srcRow, { ...emptyBalance(m, m.from_location_id), ...srcNext }, at)
      saveBalance(dstRow, { ...emptyBalance(m, m.location_id), ...dstNext }, at)
      db.exec('COMMIT')
      return { id: Number(info.lastInsertRowid), balance: { ...emptyBalance(m, m.location_id), ...dstNext, available: availableOf(dstNext) } }
    }
    const row = findBalance(m, m.location_id ?? null)
    const cur = bucketsOf(row)
    const next = applyToBalance(cur, m)
    const info = insertMovement(cur.on_hand, next.on_hand)
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

// ---------- Inbound GĐ1 (port từ src/domain/inbound/* — giữ khớp bản TS) ----------
const PO_MANUAL_TRANSITIONS = { DRAFT: ['SENT', 'CANCELLED'], SENT: ['CANCELLED'], RECEIVED: ['CLOSED'] }
const NEVER_PUTAWAY_TYPES = new Set(['RECEIVING', 'DAMAGE', 'HOLD'])
function defaultWarehouseId() {
  const w = db.prepare('SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1').get()
  return w ? w.id : null
}
function findReceivingLocation(warehouseId) {
  let wh = warehouseId ?? defaultWarehouseId()
  const row = wh != null
    ? db.prepare("SELECT * FROM locations WHERE warehouse_id = ? AND loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1").get(wh)
    : db.prepare("SELECT * FROM locations WHERE loc_type = 'RECEIVING' AND active = 1 ORDER BY id LIMIT 1").get()
  if (!row) throw new Error('Chưa có vị trí nhận hàng (loại RECEIVING)')
  return row
}
const qtyPendingQcS = (l) => r6(l.qty_received - l.qty_qc_pass - l.qty_qc_fail)
const qtyAwaitingPutawayS = (l) => r6(l.qty_qc_pass - l.qty_putaway)
function lotStatusAfterS(l) {
  const qcDone = r6(l.qty_qc_pass + l.qty_qc_fail) + EPS >= l.qty_received
  const putDone = r6(l.qty_putaway) + EPS >= l.qty_qc_pass
  if (!qcDone || !putDone) return 'INSPECT'
  return l.qty_qc_pass > 0 ? 'AVAILABLE' : 'DAMAGED'
}
/** Sau QC/putaway: cập nhật trạng thái lô + đóng phiếu nhận khi mọi dòng xong. */
function refreshReceiptAndLot(receiptLineId) {
  const line = db.prepare('SELECT * FROM receipt_lines WHERE id = ?').get(receiptLineId)
  if (!line) return
  if (line.lot_id != null) {
    db.prepare('UPDATE lots SET status = ? WHERE lot_id = ?').run(lotStatusAfterS(line), line.lot_id)
  }
  const siblings = db.prepare('SELECT * FROM receipt_lines WHERE receipt_id = ?').all(line.receipt_id)
  if (siblings.every((l) => qtyPendingQcS(l) <= 0 && qtyAwaitingPutawayS(l) <= 0)) {
    db.prepare("UPDATE receipts SET status = 'DONE' WHERE id = ?").run(line.receipt_id)
  }
}
function getPoFull(id) {
  const order = db.prepare(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`).get(id)
  if (!order) return null
  const lines = db.prepare('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id').all(id)
  const receipts = db.prepare('SELECT * FROM receipts WHERE po_id = ? ORDER BY id').all(id)
    .map((r) => ({ ...r, lines: db.prepare('SELECT * FROM receipt_lines WHERE receipt_id = ? ORDER BY id').all(r.id) }))
  return { order, lines, receipts }
}

// ---------- Outbound GĐ2 (port từ src/domain/outbound/* — giữ khớp bản TS) ----------
const OB_CANCELLABLE = ['DRAFT', 'ALLOCATED', 'PARTIAL_ALLOCATED']
function getObFull(id) {
  const order = db.prepare('SELECT * FROM outbound_orders WHERE id = ?').get(id)
  if (!order) return null
  const lines = db.prepare('SELECT * FROM outbound_lines WHERE order_id = ? ORDER BY id').all(id)
    .map((l) => ({ ...l, backorder: Math.max(0, r6(l.qty_ordered - l.qty_allocated)) }))
  const allocations = db.prepare(`SELECT a.*, COALESCE(loc.code, '') AS location_code FROM allocations a
    LEFT JOIN locations loc ON loc.id = a.location_id WHERE a.order_id = ? ORDER BY a.id`).all(id)
  const w = db.prepare(`SELECT w.wave_no FROM wave_orders wo JOIN waves w ON w.id = wo.wave_id
    WHERE wo.order_id = ? AND w.status IN ('OPEN', 'PICKING') ORDER BY w.id DESC LIMIT 1`).get(id)
  return { order, lines, allocations, active_wave_no: w ? w.wave_no : '' }
}
const candidateAvailableS = (c) => Math.max(0, r6(c.on_hand - c.allocated - c.hold - c.damaged - c.inspect))
function loadObCandidates(sku) {
  return db.prepare(`SELECT b.lot_id, b.location_id, b.sku, b.on_hand, b.allocated, b.hold, b.damaged, b.inspect,
      l.status AS lot_status, l.expiry_date, loc.loc_type, loc.code AS location_code, loc.active AS location_active
    FROM stock_balances b JOIN lots l ON l.lot_id = b.lot_id JOIN locations loc ON loc.id = b.location_id
    WHERE UPPER(TRIM(b.sku)) = UPPER(TRIM(?)) AND b.lot_id IS NOT NULL AND b.location_id IS NOT NULL`).all(sku)
    .filter((c) => c.lot_status === 'AVAILABLE' && ['PICKABLE', 'BULK'].includes(c.loc_type || '')
      && c.location_active !== 0 && candidateAvailableS(c) > 0)
}
function allocateLineS(sku, qty, candidates, policy) {
  const byFefo = (a, b) => {
    const ea = a.expiry_date || null; const eb = b.expiry_date || null
    if (ea && eb && ea !== eb) return ea < eb ? -1 : 1
    if (ea && !eb) return -1
    if (!ea && eb) return 1
    return a.lot_id - b.lot_id
  }
  const sorted = [...candidates].sort(policy === 'FIFO' ? (a, b) => a.lot_id - b.lot_id : byFefo)
  const allocations = []
  let remaining = r6(qty)
  for (const c of sorted) {
    if (remaining <= 0) break
    const take = Math.min(candidateAvailableS(c), remaining)
    if (take > 0) { allocations.push({ lot_id: c.lot_id, location_id: c.location_id, qty: r6(take) }); remaining = r6(remaining - take) }
  }
  return { allocations, qty_allocated: r6(qty - remaining), backorder: remaining }
}
const retPendingQcS = (l) => r6(l.qty_returned - l.qty_qc_pass - l.qty_qc_fail)
const retAwaitingPutawayS = (l) => r6(l.qty_qc_pass - l.qty_putaway)
/** Sau QC/putaway hàng trả: cập nhật trạng thái phiếu trả + lô sinh từ phiếu trả. */
function refreshReturnS(returnId, changedLineId) {
  const lines = db.prepare('SELECT * FROM return_lines WHERE return_id = ?').all(returnId)
  const qcDone = lines.every((l) => retPendingQcS(l) <= 0)
  const status = !qcDone ? 'RECEIVED' : (lines.every((l) => retAwaitingPutawayS(l) <= 0) ? 'DONE' : 'QC_DONE')
  db.prepare('UPDATE returns SET status = ? WHERE id = ?').run(status, returnId)
  const line = lines.find((l) => l.id === changedLineId)
  if (line && line.lot_id != null) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM receipt_lines WHERE lot_id = ?').get(line.lot_id)
    if (n === 0) {
      const adapted = { qty_received: line.qty_returned, qty_qc_pass: line.qty_qc_pass, qty_qc_fail: line.qty_qc_fail, qty_putaway: line.qty_putaway }
      db.prepare('UPDATE lots SET status = ? WHERE lot_id = ?').run(lotStatusAfterS(adapted), line.lot_id)
    }
  }
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

    // --- Inbound GĐ1: PO -> nhận -> QC -> putaway (cần đăng nhập + thiết bị duyệt) ---
    if (p === '/api/purchase-orders' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const status = url.searchParams.get('status')
      const rows = status
        ? db.prepare(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = ? ORDER BY po.id DESC`).all(status)
        : db.prepare(`SELECT po.*, COALESCE(s.name, '') AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC`).all()
      return sendJson(res, 200, { purchase_orders: rows })
    }
    if (p === '/api/purchase-orders' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'purchase_create')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền purchase_create' })
      const body = await readBody(req)
      const lines = Array.isArray(body.lines) ? body.lines : []
      if (!lines.length) return sendJson(res, 400, { error: 'invalid_po', message: 'PO phải có ít nhất 1 dòng hàng' })
      for (const l of lines) {
        if (!String(l.sku || '').trim()) return sendJson(res, 400, { error: 'invalid_po', message: 'Dòng PO thiếu SKU' })
        if (!Number.isFinite(Number(l.qty_ordered)) || Number(l.qty_ordered) <= 0) {
          return sendJson(res, 400, { error: 'invalid_po', message: `Dòng ${l.sku}: số lượng đặt phải lớn hơn 0` })
        }
      }
      const at = nowStamp()
      const warehouseId = body.warehouse_id ?? defaultWarehouseId()
      const total = r6(lines.reduce((sum, l) => sum + Number(l.qty_ordered) * (Number(l.unit_price) || 0), 0))
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE po_counter SET n = n + 1 WHERE id = 1').run()
        const info = db.prepare(`INSERT INTO purchase_orders (po_no, supplier_id, warehouse_id, expected_date, status, total_amount, note, created_at, updated_at, created_by)
          VALUES ((SELECT 'PO-' || printf('%04d', n) FROM po_counter WHERE id = 1), ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`)
          .run(body.supplier_id ?? null, warehouseId, body.expected_date ?? null, total, body.note ?? null, at, at, s.username)
        const poId = Number(info.lastInsertRowid)
        const upsertProduct = db.prepare(`INSERT INTO products (sku, name, uom, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sku) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), products.name), updated_at = excluded.updated_at`)
        const insLine = db.prepare(`INSERT INTO po_lines (po_id, product_id, sku, description, uom, qty_ordered, unit_price, expected_batch, note)
          VALUES (?, (SELECT id FROM products WHERE sku = ?), ?, ?, ?, ?, ?, ?, ?)`)
        for (const l of lines) {
          const sku = String(l.sku).trim()
          upsertProduct.run(sku, l.description ?? '', l.uom ?? '', at, at)
          insLine.run(poId, sku, sku, l.description ?? null, l.uom ?? null, Number(l.qty_ordered),
            l.unit_price == null ? null : Number(l.unit_price), l.expected_batch ?? null, l.note ?? null)
        }
        db.exec('COMMIT')
        const po = db.prepare('SELECT po_no FROM purchase_orders WHERE id = ?').get(poId)
        return sendJson(res, 201, { id: poId, po_no: po.po_no })
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'po_rejected', message: String(e.message || e) })
      }
    }
    const poIdMatch = /^\/api\/purchase-orders\/(\d+)$/.exec(p)
    if (poIdMatch && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const full = getPoFull(Number(poIdMatch[1]))
      if (!full) return sendJson(res, 404, { error: 'po_not_found', message: 'Không tìm thấy PO' })
      return sendJson(res, 200, full)
    }
    const poTransition = /^\/api\/purchase-orders\/(\d+)\/transition$/.exec(p)
    if (poTransition && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'purchase_create')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền purchase_create' })
      const body = await readBody(req)
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(poTransition[1]))
      if (!po) return sendJson(res, 404, { error: 'po_not_found', message: 'Không tìm thấy PO' })
      const allowed = PO_MANUAL_TRANSITIONS[po.status] || []
      if (!allowed.includes(String(body.to))) {
        return sendJson(res, 400, { error: 'invalid_transition', message: `Không chuyển được PO từ ${po.status} sang ${body.to}` })
      }
      db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(String(body.to), nowStamp(), po.id)
      return sendJson(res, 200, { id: po.id, status: String(body.to) })
    }
    const poReceive = /^\/api\/purchase-orders\/(\d+)\/receive$/.exec(p)
    if (poReceive && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'purchase_receive')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền purchase_receive' })
      const body = await readBody(req)
      const poId = Number(poReceive[1])
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId)
      if (!po) return sendJson(res, 404, { error: 'po_not_found', message: 'Không tìm thấy PO' })
      if (!['SENT', 'PARTIAL'].includes(po.status)) {
        return sendJson(res, 400, { error: 'po_not_receivable', message: `PO đang ở trạng thái ${po.status}, chưa nhận hàng được` })
      }
      let recvLoc
      try { recvLoc = findReceivingLocation(po.warehouse_id) } catch (e) {
        return sendJson(res, 400, { error: 'no_receiving_location', message: String(e.message || e) })
      }
      const poLines = db.prepare('SELECT * FROM po_lines WHERE po_id = ? ORDER BY id').all(poId)
      const inputs = (Array.isArray(body.lines) ? body.lines : []).filter((i) => Number(i.qty_received) > 0)
      if (!inputs.length) return sendJson(res, 400, { error: 'nothing_received', message: 'Chưa nhập số lượng thực nhận cho dòng nào' })
      const seen = new Set()
      for (const i of inputs) {
        const line = poLines.find((l) => l.id === Number(i.po_line_id))
        if (!line) return sendJson(res, 400, { error: 'invalid_line', message: `Dòng PO ${i.po_line_id} không thuộc đơn này` })
        if (seen.has(line.id)) return sendJson(res, 400, { error: 'invalid_line', message: `Dòng ${line.sku} bị nhập hai lần` })
        seen.add(line.id)
        if (Number(i.qty_damaged || 0) > Number(i.qty_received)) {
          return sendJson(res, 400, { error: 'invalid_line', message: `Dòng ${line.sku}: số hỏng lớn hơn số thực nhận` })
        }
      }
      const at = nowStamp()
      let receiptId; let receiptNo; const movements = []
      db.exec('BEGIN IMMEDIATE')
      try {
        const { n: nReceipts } = db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE po_id = ?').get(poId)
        receiptNo = `${po.po_no}-R${nReceipts + 1}`
        const rInfo = db.prepare(`INSERT INTO receipts (receipt_no, po_id, warehouse_id, received_by, received_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'QC_PENDING', ?)`).run(receiptNo, poId, po.warehouse_id, s.username, at, at)
        receiptId = Number(rInfo.lastInsertRowid)
        const { n: lotCounter } = db.prepare('SELECT n FROM lot_counter WHERE id = 1').get()
        let nextLot = lotCounter
        const insRl = db.prepare(`INSERT INTO receipt_lines (receipt_id, po_line_id, sku, qty_expected, qty_received, qty_good, qty_damaged, qty_shortage, qty_more, lot_id, qc_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`)
        const insLot = db.prepare(`INSERT INTO lots (lot_id, sku, product_id, batch_no, lot_no, manuf_date, expiry_date, supplier_id, purchase_price, status, source_po_id, source_receipt_line_id, location_id, created_at)
          VALUES (?, ?, (SELECT id FROM products WHERE sku = ?), ?, ?, ?, ?, ?, ?, 'INSPECT', ?, ?, ?, ?)`)
        for (const i of inputs) {
          const line = poLines.find((l) => l.id === Number(i.po_line_id))
          const qtyReceived = Number(i.qty_received); const qtyDamaged = Number(i.qty_damaged || 0)
          const qtyExpected = Math.max(0, r6(line.qty_ordered - line.qty_received))
          const lotId = ++nextLot
          const rl = insRl.run(receiptId, line.id, line.sku, qtyExpected, qtyReceived, r6(qtyReceived - qtyDamaged), qtyDamaged,
            Math.max(0, r6(qtyExpected - qtyReceived)), Math.max(0, r6(qtyReceived - qtyExpected)), lotId)
          insLot.run(lotId, line.sku, line.sku, i.batch_no ?? null, i.lot_no ?? null, i.manuf_date ?? null, i.expiry_date ?? null,
            po.supplier_id, i.purchase_price == null ? null : Number(i.purchase_price), poId, Number(rl.lastInsertRowid), recvLoc.id, at)
          db.prepare('UPDATE po_lines SET qty_received = ?, qty_damaged = ? WHERE id = ?')
            .run(r6(line.qty_received + qtyReceived), r6(line.qty_damaged + qtyDamaged), line.id)
          line.qty_received = r6(line.qty_received + qtyReceived)
          movements.push({
            type: 'RECEIVE', sku: line.sku, lot_id: lotId, qty: qtyReceived, warehouse_id: po.warehouse_id,
            location_id: recvLoc.id, into_inspect: true, doc_type: 'RECEIPT', doc_id: receiptId,
          })
        }
        db.prepare('UPDATE lot_counter SET n = ? WHERE id = 1').run(nextLot)
        const done = poLines.every((l) => r6(l.qty_received) + EPS >= l.qty_ordered)
        db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(done ? 'RECEIVED' : 'PARTIAL', at, poId)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'receive_rejected', message: String(e.message || e) })
      }
      try {
        for (const m of movements) applyMovementTxn(m, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      return sendJson(res, 201, { receipt_id: receiptId, receipt_no: receiptNo })
    }
    const receiptQc = /^\/api\/receipts\/(\d+)\/qc$/.exec(p)
    if (receiptQc && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_receive')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_receive' })
      const body = await readBody(req)
      const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(Number(receiptQc[1]))
      if (!receipt) return sendJson(res, 404, { error: 'receipt_not_found', message: 'Không tìm thấy phiếu nhận' })
      const line = db.prepare('SELECT * FROM receipt_lines WHERE id = ? AND receipt_id = ?').get(Number(body.receipt_line_id), receipt.id)
      if (!line) return sendJson(res, 404, { error: 'receipt_line_not_found', message: 'Không tìm thấy dòng phiếu nhận' })
      const qtyPass = Number(body.qty_pass || 0); const qtyFail = Number(body.qty_fail || 0)
      if (qtyPass + qtyFail <= 0) return sendJson(res, 400, { error: 'invalid_qc', message: 'Chưa nhập số lượng QC' })
      if (r6(qtyPass + qtyFail) > qtyPendingQcS(line) + EPS) {
        return sendJson(res, 400, { error: 'invalid_qc', message: `QC vượt số đang chờ (${qtyPendingQcS(line)})` })
      }
      if (qtyFail > 0 && !body.reason_code) {
        return sendJson(res, 400, { error: 'invalid_qc', message: 'Có hàng hỏng khi QC: bắt buộc chọn lý do' })
      }
      try {
        if (qtyFail > 0) {
          const recvLoc = findReceivingLocation(receipt.warehouse_id)
          applyMovementTxn({
            type: 'DAMAGE', sku: line.sku, lot_id: line.lot_id, qty: qtyFail, warehouse_id: receipt.warehouse_id,
            location_id: recvLoc.id, from_inspect: true, reason_code: String(body.reason_code),
            doc_type: 'RECEIPT', doc_id: receipt.id, doc_line_id: line.id,
          }, s.username)
        }
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      const newPass = r6(line.qty_qc_pass + qtyPass); const newFail = r6(line.qty_qc_fail + qtyFail)
      const done = r6(newPass + newFail) + EPS >= line.qty_received
      const qcStatus = !done ? 'PARTIAL' : (newFail === 0 ? 'PASS' : (newPass === 0 ? 'FAIL' : 'PARTIAL'))
      db.prepare(`UPDATE receipt_lines SET qty_qc_pass = ?, qty_qc_fail = ?, qc_status = ?,
        damage_reason_code = COALESCE(?, damage_reason_code) WHERE id = ?`)
        .run(newPass, newFail, qcStatus, qtyFail > 0 ? String(body.reason_code) : null, line.id)
      refreshReceiptAndLot(line.id)
      return sendJson(res, 200, { receipt_line_id: line.id, qc_status: qcStatus })
    }
    const receiptPutaway = /^\/api\/receipts\/(\d+)\/putaway$/.exec(p)
    if (receiptPutaway && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_putaway')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_putaway' })
      const body = await readBody(req)
      const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(Number(receiptPutaway[1]))
      if (!receipt) return sendJson(res, 404, { error: 'receipt_not_found', message: 'Không tìm thấy phiếu nhận' })
      const line = db.prepare('SELECT * FROM receipt_lines WHERE id = ? AND receipt_id = ?').get(Number(body.receipt_line_id), receipt.id)
      if (!line) return sendJson(res, 404, { error: 'receipt_line_not_found', message: 'Không tìm thấy dòng phiếu nhận' })
      const qty = Number(body.qty || 0)
      if (qty <= 0 || r6(qty) > qtyAwaitingPutawayS(line) + EPS) {
        return sendJson(res, 400, { error: 'invalid_putaway', message: `Số cất phải > 0 và không vượt số chờ cất (${qtyAwaitingPutawayS(line)})` })
      }
      const dest = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(body.to_location_id))
      if (!dest || dest.active !== 1) return sendJson(res, 400, { error: 'invalid_putaway', message: 'Vị trí đích không tồn tại hoặc đang tắt' })
      if (NEVER_PUTAWAY_TYPES.has(dest.loc_type)) {
        return sendJson(res, 400, { error: 'invalid_putaway', message: `Không cất hàng vào vị trí loại ${dest.loc_type}` })
      }
      let recvLoc
      try { recvLoc = findReceivingLocation(receipt.warehouse_id) } catch (e) {
        return sendJson(res, 400, { error: 'no_receiving_location', message: String(e.message || e) })
      }
      if (dest.id === recvLoc.id) return sendJson(res, 400, { error: 'invalid_putaway', message: 'Vị trí đích trùng vị trí nhận hàng' })
      try {
        applyMovementTxn({
          type: 'PUTAWAY', sku: line.sku, lot_id: line.lot_id, qty, warehouse_id: receipt.warehouse_id,
          from_location_id: recvLoc.id, location_id: dest.id, doc_type: 'RECEIPT', doc_id: receipt.id, doc_line_id: line.id,
        }, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      db.prepare('UPDATE receipt_lines SET qty_putaway = ? WHERE id = ?').run(r6(line.qty_putaway + qty), line.id)
      if (line.lot_id != null) db.prepare('UPDATE lots SET location_id = ? WHERE lot_id = ?').run(dest.id, line.lot_id)
      refreshReceiptAndLot(line.id)
      return sendJson(res, 200, { receipt_line_id: line.id, qty_putaway: r6(line.qty_putaway + qty) })
    }
    if (p === '/api/lots' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const sku = url.searchParams.get('sku')
      const rows = sku
        ? db.prepare('SELECT * FROM lots WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) ORDER BY lot_id').all(sku)
        : db.prepare('SELECT * FROM lots ORDER BY lot_id').all()
      return sendJson(res, 200, { lots: rows })
    }
    if (p === '/api/locations' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      return sendJson(res, 200, {
        warehouses: db.prepare('SELECT * FROM warehouses ORDER BY id').all(),
        zones: db.prepare('SELECT * FROM zones ORDER BY id').all(),
        locations: db.prepare('SELECT * FROM locations ORDER BY pick_sequence, code').all(),
      })
    }

    // --- Outbound GĐ2: đơn xuất -> phân bổ -> wave/pick -> pack -> ship -> returns ---
    if (p === '/api/outbound-orders' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const status = url.searchParams.get('status')
      const rows = status
        ? db.prepare('SELECT * FROM outbound_orders WHERE status = ? ORDER BY id DESC').all(status)
        : db.prepare('SELECT * FROM outbound_orders ORDER BY id DESC').all()
      return sendJson(res, 200, { outbound_orders: rows })
    }
    if (p === '/api/outbound-orders' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_allocate')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_allocate' })
      const body = await readBody(req)
      const lines = Array.isArray(body.lines) ? body.lines : []
      if (!lines.length) return sendJson(res, 400, { error: 'invalid_order', message: 'Đơn xuất phải có ít nhất 1 dòng hàng' })
      for (const l of lines) {
        if (!String(l.sku || '').trim()) return sendJson(res, 400, { error: 'invalid_order', message: 'Dòng đơn xuất thiếu SKU' })
        if (!Number.isFinite(Number(l.qty_ordered)) || Number(l.qty_ordered) <= 0) {
          return sendJson(res, 400, { error: 'invalid_order', message: `Dòng ${l.sku}: số lượng xuất phải lớn hơn 0` })
        }
      }
      const at = nowStamp()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE ob_counter SET n = n + 1 WHERE id = 1').run()
        const info = db.prepare(`INSERT INTO outbound_orders (order_no, source, external_ref, customer_name, customer_code, warehouse_id, status, carrier_text, note, created_at, updated_at, created_by)
          VALUES ((SELECT 'XH-' || printf('%04d', n) FROM ob_counter WHERE id = 1), ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`)
          .run(body.source ?? 'MANUAL', body.external_ref ?? null, body.customer_name ?? null, body.customer_code ?? null,
            body.warehouse_id ?? defaultWarehouseId(), body.carrier_text ?? null, body.note ?? null, at, at, s.username)
        const orderId = Number(info.lastInsertRowid)
        const insLine = db.prepare('INSERT INTO outbound_lines (order_id, sku, description, uom, qty_ordered, note) VALUES (?, ?, ?, ?, ?, ?)')
        for (const l of lines) insLine.run(orderId, String(l.sku).trim(), l.description ?? null, l.uom ?? null, Number(l.qty_ordered), l.note ?? null)
        db.exec('COMMIT')
        const o = db.prepare('SELECT order_no FROM outbound_orders WHERE id = ?').get(orderId)
        return sendJson(res, 201, { id: orderId, order_no: o.order_no })
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'order_rejected', message: String(e.message || e) })
      }
    }
    const obIdMatch = /^\/api\/outbound-orders\/(\d+)$/.exec(p)
    if (obIdMatch && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const full = getObFull(Number(obIdMatch[1]))
      if (!full) return sendJson(res, 404, { error: 'order_not_found', message: 'Không tìm thấy đơn xuất' })
      return sendJson(res, 200, full)
    }
    const obAllocate = /^\/api\/outbound-orders\/(\d+)\/allocate$/.exec(p)
    if (obAllocate && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_allocate')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_allocate' })
      const body = await readBody(req)
      const orderId = Number(obAllocate[1])
      const full = getObFull(orderId)
      if (!full) return sendJson(res, 404, { error: 'order_not_found', message: 'Không tìm thấy đơn xuất' })
      const { order, lines } = full
      if (!['DRAFT', 'PARTIAL_ALLOCATED'].includes(order.status)) {
        return sendJson(res, 400, { error: 'not_allocatable', message: `Đơn đang ở trạng thái ${order.status}, không phân bổ thêm được` })
      }
      const policy = ['FEFO', 'FIFO', 'FEFO_THEN_FIFO'].includes(String(body.policy)) ? String(body.policy) : 'FEFO_THEN_FIFO'
      const consumed = new Map()
      const movements = []
      const results = []
      db.exec('BEGIN IMMEDIATE')
      try {
        const insAlloc = db.prepare(`INSERT INTO allocations (order_id, order_line_id, lot_id, location_id, sku, qty_allocated, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`)
        for (const line of lines) {
          const need = r6(line.qty_ordered - line.qty_allocated)
          if (need <= 0) { results.push({ line_id: line.id, sku: line.sku, qty_allocated: 0, backorder: 0 }); continue }
          const cands = loadObCandidates(line.sku).map((c) => {
            const extra = consumed.get(`${c.location_id}|${c.lot_id}`) || 0
            return extra > 0 ? { ...c, allocated: r6(c.allocated + extra) } : c
          })
          const r = allocateLineS(line.sku, need, cands, policy)
          for (const sl of r.allocations) {
            insAlloc.run(orderId, line.id, sl.lot_id, sl.location_id, line.sku, sl.qty, nowStamp())
            consumed.set(`${sl.location_id}|${sl.lot_id}`, r6((consumed.get(`${sl.location_id}|${sl.lot_id}`) || 0) + sl.qty))
            movements.push({
              type: 'ALLOCATE', sku: line.sku, lot_id: sl.lot_id, qty: sl.qty, warehouse_id: order.warehouse_id,
              location_id: sl.location_id, doc_type: 'PICK_ORDER', doc_id: orderId, doc_line_id: line.id,
            })
          }
          line.qty_allocated = r6(line.qty_allocated + r.qty_allocated)
          db.prepare('UPDATE outbound_lines SET qty_allocated = ? WHERE id = ?').run(line.qty_allocated, line.id)
          results.push({ line_id: line.id, sku: line.sku, qty_allocated: r.qty_allocated, backorder: r.backorder })
        }
        const fullAlloc = lines.every((l) => r6(l.qty_allocated) + EPS >= l.qty_ordered)
        db.prepare('UPDATE outbound_orders SET status = ?, updated_at = ? WHERE id = ?')
          .run(fullAlloc ? 'ALLOCATED' : 'PARTIAL_ALLOCATED', nowStamp(), orderId)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'allocate_rejected', message: String(e.message || e) })
      }
      try {
        for (const m of movements) applyMovementTxn(m, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      const after = getObFull(orderId)
      return sendJson(res, 200, { id: orderId, status: after.order.status, results })
    }
    const obCancel = /^\/api\/outbound-orders\/(\d+)\/cancel$/.exec(p)
    if (obCancel && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_allocate')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_allocate' })
      const orderId = Number(obCancel[1])
      const full = getObFull(orderId)
      if (!full) return sendJson(res, 404, { error: 'order_not_found', message: 'Không tìm thấy đơn xuất' })
      const { order, allocations } = full
      if (full.active_wave_no) return sendJson(res, 400, { error: 'in_wave', message: `Đơn đang nằm trong wave ${full.active_wave_no}` })
      if (allocations.some((a) => a.qty_picked > 0)) {
        return sendJson(res, 400, { error: 'already_picked', message: 'Đơn đã lấy hàng một phần — không huỷ được' })
      }
      if (!OB_CANCELLABLE.includes(order.status)) {
        return sendJson(res, 400, { error: 'not_cancellable', message: `Đơn đang ở trạng thái ${order.status}, không huỷ được` })
      }
      const movements = []
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const a of allocations) {
          if (a.status !== 'ACTIVE') continue
          const remaining = r6(a.qty_allocated - a.qty_picked)
          if (remaining > 0) {
            movements.push({
              type: 'DEALLOCATE', sku: a.sku, lot_id: a.lot_id, qty: remaining, warehouse_id: order.warehouse_id,
              location_id: a.location_id, doc_type: 'PICK_ORDER', doc_id: orderId, doc_line_id: a.order_line_id,
            })
            db.prepare('UPDATE outbound_lines SET qty_allocated = qty_allocated - ? WHERE id = ?').run(remaining, a.order_line_id)
          }
          db.prepare("UPDATE allocations SET status = 'RELEASED' WHERE id = ?").run(a.id)
        }
        db.prepare("UPDATE outbound_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(nowStamp(), orderId)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'cancel_rejected', message: String(e.message || e) })
      }
      try {
        for (const m of movements) applyMovementTxn(m, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      return sendJson(res, 200, { id: orderId, status: 'CANCELLED' })
    }
    if (p === '/api/waves' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      return sendJson(res, 200, { waves: db.prepare('SELECT * FROM waves ORDER BY id DESC').all() })
    }
    if (p === '/api/waves' && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_pick')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_pick' })
      const body = await readBody(req)
      const orderIds = Array.isArray(body.order_ids) ? body.order_ids.map(Number) : []
      if (!orderIds.length) return sendJson(res, 400, { error: 'invalid_wave', message: 'Chưa chọn đơn nào cho wave' })
      const inputs = []
      let warehouseId = null
      for (const oid of orderIds) {
        const full = getObFull(oid)
        if (!full) return sendJson(res, 404, { error: 'order_not_found', message: `Không tìm thấy đơn xuất #${oid}` })
        if (full.active_wave_no) return sendJson(res, 400, { error: 'in_wave', message: `Đơn ${full.order.order_no} đã nằm trong wave ${full.active_wave_no}` })
        if (!['ALLOCATED', 'PARTIAL_ALLOCATED'].includes(full.order.status)) {
          return sendJson(res, 400, { error: 'not_ready', message: `Đơn ${full.order.order_no} đang ở trạng thái ${full.order.status}` })
        }
        warehouseId = warehouseId ?? full.order.warehouse_id
        for (const a of full.allocations) {
          if (a.status !== 'ACTIVE') continue
          const remaining = r6(a.qty_allocated - a.qty_picked)
          if (remaining <= 0 || a.location_id == null || a.lot_id == null) continue
          const loc = db.prepare('SELECT code, pick_sequence FROM locations WHERE id = ?').get(a.location_id)
          inputs.push({
            allocation_id: a.id, order_id: oid, order_line_id: a.order_line_id, lot_id: a.lot_id,
            location_id: a.location_id, location_code: loc ? loc.code : '', pick_sequence: loc ? loc.pick_sequence : null,
            sku: a.sku, qty_remaining: remaining,
          })
        }
      }
      // Gộp theo (lô, vị trí), sắp theo lộ trình lấy — port buildPickTasks.
      const groups = new Map()
      for (const a of inputs) {
        const key = `${a.location_id}|${a.lot_id}`
        if (!groups.has(key)) groups.set(key, { ...a, qty_need: 0, parts: [] })
        const g = groups.get(key)
        g.qty_need = r6(g.qty_need + a.qty_remaining)
        const part = g.parts.find((x) => x.allocation_id === a.allocation_id)
        if (part) part.qty = r6(part.qty + a.qty_remaining)
        else g.parts.push({ allocation_id: a.allocation_id, qty: a.qty_remaining })
      }
      const tasks = [...groups.values()].sort((x, y) =>
        (x.pick_sequence ?? Number.MAX_SAFE_INTEGER) - (y.pick_sequence ?? Number.MAX_SAFE_INTEGER)
        || String(x.location_code).localeCompare(String(y.location_code)) || x.lot_id - y.lot_id)
      if (!tasks.length) return sendJson(res, 400, { error: 'invalid_wave', message: 'Các đơn đã chọn không còn allocation nào cần lấy' })
      const at = nowStamp()
      let waveId; let waveNo
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE wave_counter SET n = n + 1 WHERE id = 1').run()
        const info = db.prepare(`INSERT INTO waves (wave_no, warehouse_id, status, carrier_text, cutoff, note, created_at, created_by)
          VALUES ((SELECT 'WV-' || printf('%04d', n) FROM wave_counter WHERE id = 1), ?, 'OPEN', ?, ?, ?, ?, ?)`)
          .run(warehouseId, body.carrier_text ?? null, body.cutoff ?? null, body.note ?? null, at, s.username)
        waveId = Number(info.lastInsertRowid)
        waveNo = db.prepare('SELECT wave_no FROM waves WHERE id = ?').get(waveId).wave_no
        const insWo = db.prepare('INSERT INTO wave_orders (wave_id, order_id) VALUES (?, ?)')
        for (const oid of orderIds) insWo.run(waveId, oid)
        const insTask = db.prepare(`INSERT INTO pick_tasks (wave_id, allocation_id, order_id, order_line_id, location_id, location_code, lot_id, sku, qty_need, pick_sequence, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
        const insPart = db.prepare('INSERT INTO pick_task_allocations (task_id, allocation_id, qty_covered) VALUES (?, ?, ?)')
        for (const t of tasks) {
          const first = inputs.find((i) => i.allocation_id === t.parts[0].allocation_id)
          const ti = insTask.run(waveId, first.allocation_id, first.order_id, first.order_line_id, t.location_id,
            t.location_code, t.lot_id, t.sku, t.qty_need, t.pick_sequence, at)
          for (const part of t.parts) insPart.run(Number(ti.lastInsertRowid), part.allocation_id, part.qty)
        }
        for (const oid of orderIds) {
          db.prepare("UPDATE outbound_orders SET status = 'PICKING', updated_at = ? WHERE id = ? AND status IN ('ALLOCATED', 'PARTIAL_ALLOCATED')").run(at, oid)
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'wave_rejected', message: String(e.message || e) })
      }
      return sendJson(res, 201, { wave_id: waveId, wave_no: waveNo, task_count: tasks.length })
    }
    const waveTasks = /^\/api\/waves\/(\d+)\/tasks$/.exec(p)
    if (waveTasks && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const wave = db.prepare('SELECT * FROM waves WHERE id = ?').get(Number(waveTasks[1]))
      if (!wave) return sendJson(res, 404, { error: 'wave_not_found', message: 'Không tìm thấy wave' })
      const tasks = db.prepare('SELECT * FROM pick_tasks WHERE wave_id = ? ORDER BY pick_sequence, location_code, id').all(wave.id)
        .map((t) => ({
          ...t,
          parts: db.prepare('SELECT allocation_id, qty_covered FROM pick_task_allocations WHERE task_id = ? ORDER BY allocation_id').all(t.id),
        }))
      const orderNos = db.prepare('SELECT o.order_no FROM wave_orders wo JOIN outbound_orders o ON o.id = wo.order_id WHERE wo.wave_id = ? ORDER BY o.id').all(wave.id).map((r) => r.order_no)
      return sendJson(res, 200, { wave, order_nos: orderNos, tasks })
    }
    const pickConfirm = /^\/api\/pick-tasks\/(\d+)\/confirm$/.exec(p)
    if (pickConfirm && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_pick')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_pick' })
      const body = await readBody(req)
      const task = db.prepare('SELECT * FROM pick_tasks WHERE id = ?').get(Number(pickConfirm[1]))
      if (!task) return sendJson(res, 404, { error: 'task_not_found', message: 'Không tìm thấy pick task' })
      if (task.status !== 'PENDING') return sendJson(res, 400, { error: 'task_done', message: `Task đã xác nhận (${task.status})` })
      const qtyActual = Number(body.qty)
      if (!Number.isFinite(qtyActual) || qtyActual < 0) {
        return sendJson(res, 400, { error: 'invalid_pick', message: 'Số lượng thực lấy không hợp lệ' })
      }
      const parts = db.prepare('SELECT * FROM pick_task_allocations WHERE task_id = ? ORDER BY allocation_id').all(task.id)
      const totalCovered = r6(parts.reduce((sum, x) => sum + x.qty_covered, 0))
      if (r6(qtyActual) > totalCovered + EPS) {
        return sendJson(res, 400, { error: 'invalid_pick', message: `Lấy vượt số đã phân bổ cho task: ${qtyActual} > ${totalCovered}` })
      }
      const wave = db.prepare('SELECT * FROM waves WHERE id = ?').get(task.wave_id)
      const movements = []
      const slices = []
      let remaining = r6(qtyActual)
      for (const part of parts) {
        const a = db.prepare('SELECT * FROM allocations WHERE id = ?').get(part.allocation_id)
        const cap = Math.min(part.qty_covered, r6(a.qty_allocated - a.qty_picked))
        const take = Math.min(cap, remaining)
        remaining = r6(remaining - take)
        const release = r6(cap - take)
        slices.push({ a, take, release })
        if (take > 0) movements.push({
          type: 'PICK', sku: a.sku, lot_id: a.lot_id, qty: take, warehouse_id: wave ? wave.warehouse_id : null,
          location_id: a.location_id, doc_type: 'PICK_ORDER', doc_id: a.order_id, doc_line_id: a.order_line_id,
        })
        if (release > 0) movements.push({
          type: 'DEALLOCATE', sku: a.sku, lot_id: a.lot_id, qty: release, warehouse_id: wave ? wave.warehouse_id : null,
          location_id: a.location_id, doc_type: 'PICK_ORDER', doc_id: a.order_id, doc_line_id: a.order_line_id,
        })
      }
      try {
        for (const m of movements) applyMovementTxn(m, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      let totalPicked = 0; let totalReleased = 0
      for (const { a, take, release } of slices) {
        const pickedAfter = r6(a.qty_picked + take)
        const allocatedAfter = r6(a.qty_allocated - release)
        const st = pickedAfter + EPS >= allocatedAfter ? (release > 0 ? 'SHORT' : 'PICKED') : 'ACTIVE'
        db.prepare('UPDATE allocations SET qty_allocated = ?, qty_picked = ?, status = ? WHERE id = ?')
          .run(allocatedAfter, pickedAfter, st, a.id)
        db.prepare('UPDATE outbound_lines SET qty_picked = qty_picked + ?, qty_allocated = qty_allocated - ? WHERE id = ?')
          .run(take, release, a.order_line_id)
        totalPicked = r6(totalPicked + take); totalReleased = r6(totalReleased + release)
      }
      const taskStatus = totalReleased > 0 ? 'SHORT' : 'PICKED'
      db.prepare('UPDATE pick_tasks SET qty_picked = ?, status = ?, picked_by = ?, picked_at = ? WHERE id = ?')
        .run(totalPicked, taskStatus, s.username, nowStamp(), task.id)
      const { n: rest } = db.prepare("SELECT COUNT(*) AS n FROM pick_tasks WHERE wave_id = ? AND status = 'PENDING'").get(task.wave_id)
      db.prepare('UPDATE waves SET status = ? WHERE id = ?').run(rest === 0 ? 'DONE' : 'PICKING', task.wave_id)
      return sendJson(res, 200, { task_id: task.id, status: taskStatus, qty_picked: totalPicked, qty_released: totalReleased })
    }
    const obPack = /^\/api\/outbound-orders\/(\d+)\/pack$/.exec(p)
    if (obPack && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_pack')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_pack' })
      const body = await readBody(req)
      const orderId = Number(obPack[1])
      const full = getObFull(orderId)
      if (!full) return sendJson(res, 404, { error: 'order_not_found', message: 'Không tìm thấy đơn xuất' })
      if (full.order.status !== 'PICKING') {
        return sendJson(res, 400, { error: 'not_packable', message: `Đơn đang ở trạng thái ${full.order.status} — cần PICKING mới đóng gói được` })
      }
      const scans = Array.isArray(body.scans) ? body.scans : []
      if (!scans.length) return sendJson(res, 400, { error: 'invalid_pack', message: 'Chưa có dòng đóng gói nào' })
      // Kiểm chứng tuần tự theo SKU (port summarizePack): sai SKU / vượt đã lấy -> 400.
      const working = full.lines.map((l) => ({ ...l }))
      for (const scan of scans) {
        const sku = String(scan.sku || '').trim()
        const qty = Number(scan.qty)
        if (!sku || !Number.isFinite(qty) || qty <= 0) {
          return sendJson(res, 400, { error: 'invalid_pack', message: 'Dòng đóng gói thiếu SKU hoặc SL không hợp lệ' })
        }
        const sameSku = working.filter((l) => l.sku.trim().toUpperCase() === sku.toUpperCase())
        const picked = r6(sameSku.reduce((sum, l) => sum + l.qty_picked, 0))
        const packed = r6(sameSku.reduce((sum, l) => sum + l.qty_packed, 0))
        if (!sameSku.length || picked <= 0) {
          return sendJson(res, 400, { error: 'invalid_pack', message: `SKU ${sku} không thuộc phần đã lấy của đơn này` })
        }
        if (r6(packed + qty) > picked + EPS) {
          return sendJson(res, 400, { error: 'invalid_pack', message: `Đóng gói vượt số đã lấy của ${sku}: đã gói ${packed} + ${qty} > đã lấy ${picked}` })
        }
        let left = r6(qty)
        for (const l of working) {
          if (left <= 0) break
          if (l.sku.trim().toUpperCase() !== sku.toUpperCase()) continue
          const add = Math.min(r6(l.qty_picked - l.qty_packed), left)
          l.qty_packed = r6(l.qty_packed + add); left = r6(left - add)
        }
      }
      for (const l of working) {
        db.prepare('UPDATE outbound_lines SET qty_packed = ? WHERE id = ?').run(l.qty_packed, l.id)
      }
      const bySku = new Map()
      for (const l of working) {
        const k = l.sku.trim().toUpperCase()
        const cur = bySku.get(k) || { sku: k, qty_packed: 0, qty_picked: 0 }
        cur.qty_packed = r6(cur.qty_packed + l.qty_packed); cur.qty_picked = r6(cur.qty_picked + l.qty_picked)
        bySku.set(k, cur)
      }
      const items = [...bySku.values()].filter((i) => i.qty_picked > 0 || i.qty_packed > 0)
      const complete = items.length > 0 && items.every((i) => r6(i.qty_packed) + EPS >= i.qty_picked)
      if (complete) db.prepare("UPDATE outbound_orders SET status = 'PACKED', updated_at = ? WHERE id = ?").run(nowStamp(), orderId)
      return sendJson(res, 200, { id: orderId, complete, items })
    }
    const obShip = /^\/api\/outbound-orders\/(\d+)\/ship$/.exec(p)
    if (obShip && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'outbound_ship')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền outbound_ship' })
      const body = await readBody(req)
      const orderId = Number(obShip[1])
      const full = getObFull(orderId)
      if (!full) return sendJson(res, 404, { error: 'order_not_found', message: 'Không tìm thấy đơn xuất' })
      if (full.order.status !== 'PACKED') {
        return sendJson(res, 400, { error: 'not_shippable', message: `Đơn đang ở trạng thái ${full.order.status} — cần PACKED mới giao được` })
      }
      const shippable = full.allocations.filter((a) => r6(a.qty_picked - a.qty_shipped) > 0)
      if (!shippable.length) return sendJson(res, 400, { error: 'not_shippable', message: 'Không có allocation nào đã lấy để giao' })
      const at = nowStamp()
      let shipmentId; let shipmentNo
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE shipment_counter SET n = n + 1 WHERE id = 1').run()
        const info = db.prepare(`INSERT INTO shipments (shipment_no, order_id, carrier_text, tracking_text, status, shipped_at, shipped_by, created_at)
          VALUES ((SELECT 'GH-' || printf('%04d', n) FROM shipment_counter WHERE id = 1), ?, ?, ?, 'SHIPPED', ?, ?, ?)`)
          .run(orderId, body.carrier_text ?? full.order.carrier_text ?? null, body.tracking_text ?? null, at, s.username, at)
        shipmentId = Number(info.lastInsertRowid)
        shipmentNo = db.prepare('SELECT shipment_no FROM shipments WHERE id = ?').get(shipmentId).shipment_no
        const insItem = db.prepare(`INSERT INTO shipment_items (shipment_id, order_id, order_line_id, allocation_id, sku, lot_id, location_id, qty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const a of shippable) {
          insItem.run(shipmentId, orderId, a.order_line_id, a.id, a.sku, a.lot_id, a.location_id, r6(a.qty_picked - a.qty_shipped))
          db.prepare('UPDATE allocations SET qty_shipped = ? WHERE id = ?').run(a.qty_picked, a.id)
        }
        for (const l of full.lines) {
          db.prepare('UPDATE outbound_lines SET qty_shipped = ? WHERE id = ?').run(l.qty_picked, l.id)
        }
        // MVP: SHIPPED -> COMPLETED gộp ngay khi giao; không movement tồn (PICK đã trừ on_hand).
        db.prepare("UPDATE outbound_orders SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(at, orderId)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'ship_rejected', message: String(e.message || e) })
      }
      return sendJson(res, 201, { shipment_id: shipmentId, shipment_no: shipmentNo })
    }
    if (p === '/api/shipments' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const rows = db.prepare(`SELECT s.*, COALESCE(o.order_no, '') AS order_no FROM shipments s
        LEFT JOIN outbound_orders o ON o.id = s.order_id ORDER BY s.id DESC`).all()
      return sendJson(res, 200, { shipments: rows })
    }
    const shipmentIdMatch = /^\/api\/shipments\/(\d+)$/.exec(p)
    if (shipmentIdMatch && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const shipment = db.prepare(`SELECT s.*, COALESCE(o.order_no, '') AS order_no FROM shipments s
        LEFT JOIN outbound_orders o ON o.id = s.order_id WHERE s.id = ?`).get(Number(shipmentIdMatch[1]))
      if (!shipment) return sendJson(res, 404, { error: 'shipment_not_found', message: 'Không tìm thấy phiếu giao' })
      const items = db.prepare('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id').all(shipment.id)
      return sendJson(res, 200, { shipment, items })
    }
    const shipmentReturns = /^\/api\/shipments\/(\d+)\/returns$/.exec(p)
    if (shipmentReturns && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'returns_receive')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền returns_receive' })
      const body = await readBody(req)
      const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(Number(shipmentReturns[1]))
      if (!shipment) return sendJson(res, 404, { error: 'shipment_not_found', message: 'Không tìm thấy phiếu giao' })
      const inputs = (Array.isArray(body.lines) ? body.lines : []).filter((i) => Number(i.qty) > 0)
      if (!inputs.length) return sendJson(res, 400, { error: 'invalid_return', message: 'Chưa nhập số lượng trả cho dòng nào' })
      const order = db.prepare('SELECT * FROM outbound_orders WHERE id = ?').get(shipment.order_id)
      let recvLoc
      try { recvLoc = findReceivingLocation(order ? order.warehouse_id : null) } catch (e) {
        return sendJson(res, 400, { error: 'no_receiving_location', message: String(e.message || e) })
      }
      const items = db.prepare('SELECT * FROM shipment_items WHERE shipment_id = ?').all(shipment.id)
      for (const i of inputs) {
        const item = items.find((x) => x.id === Number(i.shipment_item_id))
        if (!item) return sendJson(res, 400, { error: 'invalid_return', message: `Dòng giao ${i.shipment_item_id} không thuộc phiếu giao này` })
        if (r6(Number(i.qty)) > r6(item.qty - item.qty_returned) + EPS) {
          return sendJson(res, 400, { error: 'invalid_return', message: `Trả vượt số đã giao còn lại của ${item.sku}` })
        }
      }
      const at = nowStamp()
      let returnId; let returnNo; const movements = []
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE return_counter SET n = n + 1 WHERE id = 1').run()
        const info = db.prepare(`INSERT INTO returns (return_no, shipment_id, order_id, customer_name, status, created_at, created_by)
          VALUES ((SELECT 'TH-' || printf('%04d', n) FROM return_counter WHERE id = 1), ?, ?, ?, 'RECEIVED', ?, ?)`)
          .run(shipment.id, shipment.order_id, order ? order.customer_name : null, at, s.username)
        returnId = Number(info.lastInsertRowid)
        returnNo = db.prepare('SELECT return_no FROM returns WHERE id = ?').get(returnId).return_no
        const insLine = db.prepare(`INSERT INTO return_lines (return_id, shipment_item_id, sku, lot_id, qty_returned, reason)
          VALUES (?, ?, ?, ?, ?, ?)`)
        for (const i of inputs) {
          const item = items.find((x) => x.id === Number(i.shipment_item_id))
          let lotId = item.lot_id
          if (lotId != null && !db.prepare('SELECT lot_id FROM lots WHERE lot_id = ?').get(lotId)) lotId = null
          if (lotId == null) {
            // Không rõ lô gốc -> sinh lô mới từ lot_counter để truy vết theo phiếu trả.
            db.prepare('UPDATE lot_counter SET n = n + 1 WHERE id = 1').run()
            const { n } = db.prepare('SELECT n FROM lot_counter WHERE id = 1').get()
            lotId = n
            db.prepare("INSERT INTO lots (lot_id, sku, status, location_id, created_at) VALUES (?, ?, 'INSPECT', ?, ?)")
              .run(lotId, item.sku, recvLoc.id, at)
          }
          insLine.run(returnId, item.id, item.sku, lotId, Number(i.qty), i.reason ?? null)
          db.prepare('UPDATE shipment_items SET qty_returned = qty_returned + ? WHERE id = ?').run(Number(i.qty), item.id)
          item.qty_returned = r6(item.qty_returned + Number(i.qty))
          movements.push({
            type: 'RETURN_IN', sku: item.sku, lot_id: lotId, qty: Number(i.qty),
            warehouse_id: order ? order.warehouse_id : null, location_id: recvLoc.id, into_inspect: true,
            doc_type: 'RETURN', doc_id: returnId, doc_line_id: item.id,
          })
        }
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        return sendJson(res, 400, { error: 'return_rejected', message: String(e.message || e) })
      }
      try {
        for (const m of movements) applyMovementTxn(m, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      return sendJson(res, 201, { return_id: returnId, return_no: returnNo })
    }
    const returnQc = /^\/api\/returns\/(\d+)\/qc$/.exec(p)
    if (returnQc && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_receive')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_receive' })
      const body = await readBody(req)
      const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(Number(returnQc[1]))
      if (!ret) return sendJson(res, 404, { error: 'return_not_found', message: 'Không tìm thấy phiếu trả' })
      const line = db.prepare('SELECT * FROM return_lines WHERE id = ? AND return_id = ?').get(Number(body.return_line_id), ret.id)
      if (!line) return sendJson(res, 404, { error: 'return_line_not_found', message: 'Không tìm thấy dòng hàng trả' })
      const qtyPass = Number(body.qty_pass || 0); const qtyFail = Number(body.qty_fail || 0)
      if (qtyPass + qtyFail <= 0) return sendJson(res, 400, { error: 'invalid_qc', message: 'Chưa nhập số lượng QC' })
      if (r6(qtyPass + qtyFail) > retPendingQcS(line) + EPS) {
        return sendJson(res, 400, { error: 'invalid_qc', message: `QC vượt số đang chờ (${retPendingQcS(line)})` })
      }
      if (qtyFail > 0 && !body.reason_code) {
        return sendJson(res, 400, { error: 'invalid_qc', message: 'Có hàng hỏng khi QC: bắt buộc chọn lý do' })
      }
      const order = ret.order_id != null ? db.prepare('SELECT * FROM outbound_orders WHERE id = ?').get(ret.order_id) : null
      try {
        if (qtyFail > 0) {
          const recvLoc = findReceivingLocation(order ? order.warehouse_id : null)
          applyMovementTxn({
            type: 'DAMAGE', sku: line.sku, lot_id: line.lot_id, qty: qtyFail,
            warehouse_id: order ? order.warehouse_id : null, location_id: recvLoc.id, from_inspect: true,
            reason_code: String(body.reason_code), doc_type: 'RETURN', doc_id: ret.id, doc_line_id: line.id,
          }, s.username)
        }
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      const newPass = r6(line.qty_qc_pass + qtyPass); const newFail = r6(line.qty_qc_fail + qtyFail)
      const done = r6(newPass + newFail) + EPS >= line.qty_returned
      const qcStatus = !done ? 'PARTIAL' : (newFail === 0 ? 'PASS' : (newPass === 0 ? 'FAIL' : 'PARTIAL'))
      db.prepare(`UPDATE return_lines SET qty_qc_pass = ?, qty_qc_fail = ?, qc_status = ?,
        damage_reason_code = COALESCE(?, damage_reason_code) WHERE id = ?`)
        .run(newPass, newFail, qcStatus, qtyFail > 0 ? String(body.reason_code) : null, line.id)
      refreshReturnS(ret.id, line.id)
      return sendJson(res, 200, { return_line_id: line.id, qc_status: qcStatus })
    }
    const returnPutaway = /^\/api\/returns\/(\d+)\/putaway$/.exec(p)
    if (returnPutaway && req.method === 'POST') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_putaway')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_putaway' })
      const body = await readBody(req)
      const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(Number(returnPutaway[1]))
      if (!ret) return sendJson(res, 404, { error: 'return_not_found', message: 'Không tìm thấy phiếu trả' })
      const line = db.prepare('SELECT * FROM return_lines WHERE id = ? AND return_id = ?').get(Number(body.return_line_id), ret.id)
      if (!line) return sendJson(res, 404, { error: 'return_line_not_found', message: 'Không tìm thấy dòng hàng trả' })
      const qty = Number(body.qty || 0)
      if (qty <= 0 || r6(qty) > retAwaitingPutawayS(line) + EPS) {
        return sendJson(res, 400, { error: 'invalid_putaway', message: `Số cất phải > 0 và không vượt số chờ cất (${retAwaitingPutawayS(line)})` })
      }
      const dest = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(body.to_location_id))
      if (!dest || dest.active !== 1) return sendJson(res, 400, { error: 'invalid_putaway', message: 'Vị trí đích không tồn tại hoặc đang tắt' })
      if (NEVER_PUTAWAY_TYPES.has(dest.loc_type)) {
        return sendJson(res, 400, { error: 'invalid_putaway', message: `Không cất hàng vào vị trí loại ${dest.loc_type}` })
      }
      const order = ret.order_id != null ? db.prepare('SELECT * FROM outbound_orders WHERE id = ?').get(ret.order_id) : null
      let recvLoc
      try { recvLoc = findReceivingLocation(order ? order.warehouse_id : null) } catch (e) {
        return sendJson(res, 400, { error: 'no_receiving_location', message: String(e.message || e) })
      }
      if (dest.id === recvLoc.id) return sendJson(res, 400, { error: 'invalid_putaway', message: 'Vị trí đích trùng vị trí nhận hàng' })
      try {
        applyMovementTxn({
          type: 'PUTAWAY', sku: line.sku, lot_id: line.lot_id, qty,
          warehouse_id: order ? order.warehouse_id : null, from_location_id: recvLoc.id, location_id: dest.id,
          doc_type: 'RETURN', doc_id: ret.id, doc_line_id: line.id,
        }, s.username)
      } catch (e) {
        return sendJson(res, 400, { error: 'movement_rejected', message: String(e.message || e) })
      }
      db.prepare('UPDATE return_lines SET qty_putaway = ? WHERE id = ?').run(r6(line.qty_putaway + qty), line.id)
      if (line.lot_id != null) db.prepare('UPDATE lots SET location_id = ? WHERE lot_id = ?').run(dest.id, line.lot_id)
      refreshReturnS(ret.id, line.id)
      return sendJson(res, 200, { return_line_id: line.id, qty_putaway: r6(line.qty_putaway + qty) })
    }
    if (p === '/api/returns' && req.method === 'GET') {
      const s = requireAuth(req, res); if (!s) return
      if (!requireDevice(req, res)) return
      if (!can(s.role, 'inventory_view')) return sendJson(res, 403, { error: 'forbidden', message: 'Thiếu quyền inventory_view' })
      const rows = db.prepare('SELECT * FROM returns ORDER BY id DESC').all()
        .map((r) => ({ ...r, lines: db.prepare('SELECT * FROM return_lines WHERE return_id = ? ORDER BY id').all(r.id) }))
      return sendJson(res, 200, { returns: rows })
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
