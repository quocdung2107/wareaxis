import { batch, dbReady, query } from '../db/client.ts'
import { STD_FIELDS, type StdField, type StdRow } from '../excel/reader.ts'
import type { InvRow } from './sheet.ts'
import type { WeightRow } from './weight.ts'
import { DEFAULT_UOM } from './uom.ts'
import { CUSTOMER_FIELDS, customerKey, normalizeCustomer, validateCustomer, type Customer } from './customers.ts'
import type { EditLog, EditOp, EditPlan } from './edit.ts'
import { pickOrdersUpgradeSql, picksUpgradeSql } from '../../features/pick-orders/logic.ts'
import type { ReceivePlan } from './receive.ts'
import { countPeriodActivity, lotUpgradeSql, planLotMigration, replaceRowsSql } from './lot-migrate.ts'
import { ADJUSTMENT_REASONS } from '../../domain/ledger/reasons.ts'
import { recordMovement } from './ledger.ts'
import { batch as dbBatch, query as dbQuery } from '../db/client.ts'

export type SavedMapping = Partial<Record<StdField, string>> // trường chuẩn → nhãn cột

export interface Source {
  id: number
  name: string
  sheet: string
  header_row: number
  header_rows: number
  mapping: SavedMapping
  file_name: string
  loaded_at: string
  row_count: number
  skipped: string
  period: number
}

export interface SourceInput {
  name: string
  sheet: string
  header_row: number
  header_rows: number
  mapping: SavedMapping
}

let schemaReady: Promise<unknown> | null = null

/** Gọi trước mọi truy vấn; chỉ chạy một lần. */
export function initSchema() {
  schemaReady ??= (async () => {
    await dbReady
    await batch([
      { sql: 'CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, sheet TEXT, header_row INTEGER, header_rows INTEGER, mapping TEXT, file_name TEXT, loaded_at TEXT, row_count INTEGER DEFAULT 0, skipped TEXT)' },
      { sql: `CREATE TABLE IF NOT EXISTS inventory_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, ${STD_FIELDS.map((f) => `${f} ${f.startsWith('qty_') ? 'REAL' : 'TEXT'}`).join(', ')})` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inv_source ON inventory_rows(source_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inv_sku ON inventory_rows(sku)' },
      { sql: 'CREATE TABLE IF NOT EXISTS uom_map (key TEXT PRIMARY KEY, label TEXT NOT NULL)' },
      // Lịch sử kiểm/lấy hàng: lưu sao chụp (không khoá ngoại), sống sót khi nạp lại file.
      { sql: 'CREATE TABLE IF NOT EXISTS count_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, description TEXT, source TEXT, location TEXT, batch_no TEXT, uom TEXT, qty_system REAL, qty_counted REAL, diff REAL, counted_at TEXT, note TEXT)' },
      { sql: 'CREATE TABLE IF NOT EXISTS count_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, seq INTEGER, expr TEXT, value REAL)' },
      { sql: 'CREATE TABLE IF NOT EXISTS picks (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, description TEXT, source TEXT, location TEXT, batch_no TEXT, uom TEXT, qty REAL, order_no TEXT, picked_at TEXT, note TEXT)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_count_sku ON count_sessions(sku)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_count_at ON count_sessions(counted_at)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_count_lines_session ON count_lines(session_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_picks_sku ON picks(sku)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_picks_at ON picks(picked_at)' },
      // Đơn picking cục bộ (PK-xxxx). Bộ đếm riêng: mã không bị tái dùng sau khi xoá đơn.
      { sql: `CREATE TABLE IF NOT EXISTS pick_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'open', order_ref TEXT, created_at TEXT, allow_sku_tag INTEGER NOT NULL DEFAULT 0)` },
      { sql: 'CREATE TABLE IF NOT EXISTS pick_order_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, pick_order_id INTEGER NOT NULL, sku TEXT NOT NULL, description TEXT, uom TEXT, qty_need REAL NOT NULL)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_pol_order ON pick_order_lines(pick_order_id)' },
      { sql: 'CREATE TABLE IF NOT EXISTS pick_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO pick_counter (id, n) VALUES (1, 0)' },
      // Khối lượng kg/ĐVT theo SKU. Bảng riêng: nạp lại tồn kho không đụng tới.
      { sql: 'CREATE TABLE IF NOT EXISTS sku_weight (sku_key TEXT PRIMARY KEY, sku TEXT NOT NULL, weight_kg REAL NOT NULL)' },
      // Khách hàng. pick_orders.customer_code chỉ là chữ thường, không khoá ngoại (xoá khách không ảnh hưởng PK).
      { sql: 'CREATE TABLE IF NOT EXISTS customers (code_key TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT, address TEXT, delivery_address TEXT, contact TEXT, sup TEXT, phone1 TEXT, phone2 TEXT, note TEXT)' },
      // Nhật ký sửa/di chuyển/tách/gộp dòng tồn (before/after: JSON). Không khoá ngoại, sống sót khi nạp lại file.
      { sql: 'CREATE TABLE IF NOT EXISTS inventory_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, sku TEXT, source TEXT, before TEXT, after TEXT)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_inv_edits_at ON inventory_edits(at)' },
      // ===== GĐ0 (kế hoạch v2): master data kho/vị trí + sổ cái tồn + user/thiết bị local + liên kho =====
      // Toàn bộ CREATE IF NOT EXISTS: DB cũ nâng cấp không mất dữ liệu; chạy lại không đổi gì.
      { sql: 'CREATE TABLE IF NOT EXISTS warehouses (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, address TEXT, is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, created_by TEXT)' },
      { sql: 'CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, code TEXT NOT NULL, name TEXT, zone_type TEXT, UNIQUE (warehouse_id, code))' },
      { sql: 'CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, zone_id INTEGER, code TEXT NOT NULL, barcode TEXT UNIQUE, loc_type TEXT, capacity_qty REAL, pick_sequence INTEGER, active INTEGER NOT NULL DEFAULT 1, UNIQUE (warehouse_id, code))' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_locations_pick_seq ON locations(pick_sequence)' },
      { sql: 'CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, address TEXT, tax_code TEXT, lead_time_days INTEGER, active INTEGER NOT NULL DEFAULT 1)' },
      { sql: 'CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, parent_id INTEGER)' },
      // Sổ cái tồn: append-only (chỉ INSERT; sai ghi REVERSAL). balances là cache dựng lại được từ movements.
      { sql: `CREATE TABLE IF NOT EXISTS stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement_no TEXT UNIQUE, type TEXT NOT NULL,
        warehouse_id INTEGER, location_id INTEGER, from_location_id INTEGER, lot_id INTEGER, sku TEXT NOT NULL, qty REAL NOT NULL,
        qty_before REAL, qty_after REAL, doc_type TEXT, doc_id INTEGER, doc_line_id INTEGER, reason_code TEXT, note TEXT,
        actor TEXT, reverses_movement_id INTEGER, period INTEGER, created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_mv_sku_at ON stock_movements(sku, created_at)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_mv_lot ON stock_movements(lot_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_mv_doc ON stock_movements(doc_type, doc_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_mv_loc ON stock_movements(location_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS stock_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, location_id INTEGER, lot_id INTEGER, sku TEXT NOT NULL,
        on_hand REAL NOT NULL DEFAULT 0, allocated REAL NOT NULL DEFAULT 0, hold REAL NOT NULL DEFAULT 0,
        damaged REAL NOT NULL DEFAULT 0, inspect REAL NOT NULL DEFAULT 0, in_transit REAL NOT NULL DEFAULT 0, updated_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_bal_sku ON stock_balances(sku)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_bal_key ON stock_balances(warehouse_id, location_id, lot_id)' },
      { sql: 'CREATE TABLE IF NOT EXISTS stock_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, sku TEXT NOT NULL, min_qty REAL, max_qty REAL, reorder_point REAL, reorder_qty REAL, count_class TEXT, UNIQUE (warehouse_id, sku))' },
      { sql: 'CREATE TABLE IF NOT EXISTS adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)' },
      // Người dùng/thiết bị/phiên local (dùng bởi Warehouse Server ở GĐ-LAN; standalone không bắt buộc đăng nhập).
      { sql: 'CREATE TABLE IF NOT EXISTS local_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT)' },
      { sql: 'CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_name TEXT, user_id INTEGER, token_hash TEXT, status TEXT NOT NULL DEFAULT \'PENDING\', last_seen_at TEXT, approved_by TEXT, created_at TEXT)' },
      { sql: 'CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, device_id INTEGER, token_hash TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)' },
      // Liên kho (Federation, GĐ4): peers + nhật ký truy vấn. Không lưu tồn của kho khác.
      { sql: 'CREATE TABLE IF NOT EXISTS federation_peers (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_code TEXT UNIQUE, warehouse_name TEXT, base_url TEXT, api_key_hash TEXT, share_policy TEXT, active INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT)' },
      { sql: 'CREATE TABLE IF NOT EXISTS federation_query_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, peer_warehouse_code TEXT, query_type TEXT, sku TEXT, requested_by TEXT, result_status TEXT, created_at TEXT)' },
      // ===== GĐ1 (kế hoạch v2 Phần 5.3 A/C): danh mục sản phẩm + lô + inbound PO -> nhận -> QC -> putaway =====
      // RANH GIỚI TỒN: hàng nhận qua PO sống ở lots + stock_balances (ledger) — KHÔNG vào
      // inventory_rows; tồn hiển thị của hàng nạp file (inventory_rows) không đổi vì GĐ1.
      { sql: 'CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, name TEXT, category_id INTEGER, uom TEXT, barcode TEXT, track_lot INTEGER NOT NULL DEFAULT 1, track_expiry INTEGER NOT NULL DEFAULT 0, shelf_life_days INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)' },
      { sql: `CREATE TABLE IF NOT EXISTS lots (lot_id INTEGER PRIMARY KEY, sku TEXT NOT NULL, product_id INTEGER, batch_no TEXT, lot_no TEXT,
        manuf_date TEXT, expiry_date TEXT, supplier_id INTEGER, purchase_price REAL, status TEXT NOT NULL DEFAULT 'INSPECT',
        source_po_id INTEGER, source_receipt_line_id INTEGER, location_id INTEGER, created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_lots_sku ON lots(sku, expiry_date)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status)' },
      { sql: 'CREATE TABLE IF NOT EXISTS po_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO po_counter (id, n) VALUES (1, 0)' },
      { sql: `CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, po_no TEXT UNIQUE NOT NULL, supplier_id INTEGER,
        warehouse_id INTEGER, expected_date TEXT, status TEXT NOT NULL DEFAULT 'DRAFT', total_amount REAL NOT NULL DEFAULT 0,
        note TEXT, created_at TEXT, updated_at TEXT, created_by TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status)' },
      { sql: `CREATE TABLE IF NOT EXISTS po_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, po_id INTEGER NOT NULL, product_id INTEGER, sku TEXT NOT NULL,
        description TEXT, uom TEXT, qty_ordered REAL NOT NULL, qty_received REAL NOT NULL DEFAULT 0, qty_damaged REAL NOT NULL DEFAULT 0,
        unit_price REAL, expected_batch TEXT, note TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines(po_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT UNIQUE NOT NULL, po_id INTEGER,
        warehouse_id INTEGER, received_by TEXT, received_at TEXT, status TEXT NOT NULL DEFAULT 'QC_PENDING', created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_receipts_po ON receipts(po_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS receipt_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL, po_line_id INTEGER,
        sku TEXT NOT NULL, qty_expected REAL NOT NULL DEFAULT 0, qty_received REAL NOT NULL DEFAULT 0, qty_good REAL NOT NULL DEFAULT 0,
        qty_damaged REAL NOT NULL DEFAULT 0, qty_shortage REAL NOT NULL DEFAULT 0, qty_more REAL NOT NULL DEFAULT 0,
        lot_id INTEGER, qc_status TEXT NOT NULL DEFAULT 'PENDING', qty_qc_pass REAL NOT NULL DEFAULT 0, qty_qc_fail REAL NOT NULL DEFAULT 0,
        qty_putaway REAL NOT NULL DEFAULT 0, damage_reason_code TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_receipt_lines_receipt ON receipt_lines(receipt_id)' },
      // ===== GĐ2 (kế hoạch v2 Phần 5.3D): outbound — đơn xuất / phân bổ / wave / pick / pack / ship / returns =====
      // Chỉ áp cho hàng LEDGER (lots + stock_balances của GĐ1). Luồng pick cũ
      // (pick_orders/pick_sessions trên inventory_rows) giữ nguyên, không liên quan.
      // Đơn Supabase Orders chỉ lưu THAM CHIẾU (external_ref + tên xe dạng text).
      { sql: 'CREATE TABLE IF NOT EXISTS ob_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO ob_counter (id, n) VALUES (1, 0)' },
      { sql: 'CREATE TABLE IF NOT EXISTS wave_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO wave_counter (id, n) VALUES (1, 0)' },
      { sql: 'CREATE TABLE IF NOT EXISTS shipment_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO shipment_counter (id, n) VALUES (1, 0)' },
      { sql: 'CREATE TABLE IF NOT EXISTS return_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)' },
      { sql: 'INSERT OR IGNORE INTO return_counter (id, n) VALUES (1, 0)' },
      { sql: `CREATE TABLE IF NOT EXISTS outbound_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL DEFAULT 'MANUAL', external_ref TEXT, customer_name TEXT, customer_code TEXT,
        warehouse_id INTEGER, status TEXT NOT NULL DEFAULT 'DRAFT', carrier_text TEXT, note TEXT,
        created_at TEXT, updated_at TEXT, created_by TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_ob_status ON outbound_orders(status)' },
      { sql: `CREATE TABLE IF NOT EXISTS outbound_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
        sku TEXT NOT NULL, description TEXT, uom TEXT, qty_ordered REAL NOT NULL,
        qty_allocated REAL NOT NULL DEFAULT 0, qty_picked REAL NOT NULL DEFAULT 0,
        qty_packed REAL NOT NULL DEFAULT 0, qty_shipped REAL NOT NULL DEFAULT 0, note TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_ob_lines_order ON outbound_lines(order_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
        order_line_id INTEGER NOT NULL, lot_id INTEGER, location_id INTEGER, sku TEXT NOT NULL,
        qty_allocated REAL NOT NULL, qty_picked REAL NOT NULL DEFAULT 0, qty_shipped REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_alloc_order ON allocations(order_id)' },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_alloc_line ON allocations(order_line_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS waves (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_no TEXT UNIQUE NOT NULL,
        warehouse_id INTEGER, status TEXT NOT NULL DEFAULT 'OPEN', carrier_text TEXT, cutoff TEXT, note TEXT,
        created_at TEXT, created_by TEXT)` },
      { sql: `CREATE TABLE IF NOT EXISTS wave_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL, UNIQUE (wave_id, order_id))` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_wave_orders_order ON wave_orders(order_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS pick_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, wave_id INTEGER,
        allocation_id INTEGER, order_id INTEGER, order_line_id INTEGER, location_id INTEGER, location_code TEXT,
        lot_id INTEGER, sku TEXT NOT NULL, qty_need REAL NOT NULL, qty_picked REAL NOT NULL DEFAULT 0,
        pick_sequence INTEGER, status TEXT NOT NULL DEFAULT 'PENDING', picked_by TEXT, picked_at TEXT, created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_pick_tasks_wave ON pick_tasks(wave_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS pick_task_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
        allocation_id INTEGER NOT NULL, qty_covered REAL NOT NULL, UNIQUE (task_id, allocation_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS shipments (id INTEGER PRIMARY KEY AUTOINCREMENT, shipment_no TEXT UNIQUE NOT NULL,
        order_id INTEGER NOT NULL, carrier_text TEXT, tracking_text TEXT, status TEXT NOT NULL DEFAULT 'SHIPPED',
        shipped_at TEXT, shipped_by TEXT, created_at TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS shipment_items (id INTEGER PRIMARY KEY AUTOINCREMENT, shipment_id INTEGER NOT NULL,
        order_id INTEGER, order_line_id INTEGER, allocation_id INTEGER, sku TEXT NOT NULL, lot_id INTEGER,
        location_id INTEGER, qty REAL NOT NULL, qty_returned REAL NOT NULL DEFAULT 0)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS returns (id INTEGER PRIMARY KEY AUTOINCREMENT, return_no TEXT UNIQUE NOT NULL,
        shipment_id INTEGER, order_id INTEGER, customer_name TEXT, status TEXT NOT NULL DEFAULT 'RECEIVED',
        note TEXT, created_at TEXT, created_by TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_returns_shipment ON returns(shipment_id)' },
      { sql: `CREATE TABLE IF NOT EXISTS return_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL,
        shipment_item_id INTEGER, sku TEXT NOT NULL, lot_id INTEGER, qty_returned REAL NOT NULL,
        qty_qc_pass REAL NOT NULL DEFAULT 0, qty_qc_fail REAL NOT NULL DEFAULT 0, qty_putaway REAL NOT NULL DEFAULT 0,
        qc_status TEXT NOT NULL DEFAULT 'PENDING', reason TEXT, damage_reason_code TEXT)` },
      { sql: 'CREATE INDEX IF NOT EXISTS idx_return_lines_return ON return_lines(return_id)' },
    ])
    // DB cũ: picks chưa có cột pick_order_id -> thêm (không mất dữ liệu cũ).
    const cols = (await query('PRAGMA table_info(picks)')).map((c) => String(c.name))
    await batch(picksUpgradeSql(cols).map((sql) => ({ sql })))
    const poCols = (await query('PRAGMA table_info(pick_orders)')).map((c) => String(c.name))
    const poSql = pickOrdersUpgradeSql(poCols)
    if (poSql.length) await batch(poSql.map((sql) => ({ sql })))
    await migrateLots()
    // GĐ0: inventory_edits thêm cột actor (ai thao tác) nếu DB cũ chưa có.
    const editCols = (await query('PRAGMA table_info(inventory_edits)')).map((c) => String(c.name))
    if (!editCols.includes('actor')) {
      await batch([{ sql: 'ALTER TABLE inventory_edits ADD COLUMN actor TEXT' }])
    }
    // GĐ1: stock_movements thêm 2 cột cờ inspect (DB cũ chưa có) — ALTER có kiểm tra PRAGMA.
    const mvCols = (await query('PRAGMA table_info(stock_movements)')).map((c) => String(c.name))
    const mvAdds: string[] = []
    if (!mvCols.includes('into_inspect')) mvAdds.push('ALTER TABLE stock_movements ADD COLUMN into_inspect INTEGER NOT NULL DEFAULT 0')
    if (!mvCols.includes('from_inspect')) mvAdds.push('ALTER TABLE stock_movements ADD COLUMN from_inspect INTEGER NOT NULL DEFAULT 0')
    if (mvAdds.length) await batch(mvAdds.map((sql) => ({ sql })))
    // GĐ1: seed kho mặc định + khu + vị trí nhận/cất — CHỈ khi chưa có kho nào.
    // Đã có dữ liệu (kể cả người dùng sửa) thì không đụng vào.
    const [{ n: nWh }] = await query('SELECT COUNT(*) AS n FROM warehouses')
    if (nWh === 0) {
      const at = nowStamp()
      await batch([{ sql: 'INSERT INTO warehouses (code, name, is_default, created_at, updated_at, created_by) VALUES (?, ?, 1, ?, ?, ?)', bind: ['MAIN', 'Kho chính', at, at, 'seed'] }])
      const [{ id: whIdRaw }] = await query('SELECT last_insert_rowid() AS id')
      const whId = whIdRaw as number
      await batch([
        { sql: 'INSERT INTO zones (warehouse_id, code, name, zone_type) VALUES (?, ?, ?, ?)', bind: [whId, 'RECEIVING', 'Khu nhận hàng', 'RECEIVING'] },
        { sql: 'INSERT INTO zones (warehouse_id, code, name, zone_type) VALUES (?, ?, ?, ?)', bind: [whId, 'STORAGE', 'Khu lưu trữ', 'STORAGE'] },
      ])
      const zones = await query('SELECT id, code FROM zones WHERE warehouse_id = ?', [whId])
      const zId = (code: string) => zones.find((z) => String(z.code) === code)?.id as number
      await batch([
        { sql: 'INSERT INTO locations (warehouse_id, zone_id, code, loc_type, pick_sequence) VALUES (?, ?, ?, ?, ?)', bind: [whId, zId('RECEIVING'), 'NHAN-01', 'RECEIVING', 1] },
        { sql: 'INSERT INTO locations (warehouse_id, zone_id, code, loc_type, pick_sequence) VALUES (?, ?, ?, ?, ?)', bind: [whId, zId('STORAGE'), 'A01-01', 'PICKABLE', 101] },
        { sql: 'INSERT INTO locations (warehouse_id, zone_id, code, loc_type, pick_sequence) VALUES (?, ?, ?, ?, ?)', bind: [whId, zId('STORAGE'), 'A01-02', 'PICKABLE', 102] },
      ])
    }
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM uom_map')
    if (n === 0) await batch(Object.entries(DEFAULT_UOM).map(([k, v]) => ({ sql: 'INSERT INTO uom_map VALUES (?, ?)', bind: [k, v] })))
    const [{ n: nReasons }] = await query('SELECT COUNT(*) AS n FROM adjustment_reasons')
    if (nReasons === 0) {
      await batch(ADJUSTMENT_REASONS.map((r) => ({
        sql: 'INSERT OR IGNORE INTO adjustment_reasons (code, name, requires_approval) VALUES (?, ?, ?)',
        bind: [r.code, r.name, r.requires_approval ? 1 : 0],
      })))
    }
  })()
  return schemaReady
}

/** Thêm cột/bảng lô + kỳ, cấp lot_id và chuyển đổi pick cũ trong MỘT giao dịch. Chạy lại không đổi gì. */
async function migrateLots() {
  const colsOf = async (t: string) => (await query(`PRAGMA table_info(${t})`)).map((c) => String(c.name))
  const upgrade = lotUpgradeSql({
    inventory_rows: await colsOf('inventory_rows'),
    picks: await colsOf('picks'),
    sources: await colsOf('sources'),
    pick_order_lines: await colsOf('pick_order_lines'),
  })
  const str = (v: unknown) => (v == null ? '' : String(v))
  // ALTER phải chạy trước khi SELECT các cột mới.
  await batch(upgrade.map((sql) => ({ sql })))
  const rows = (await query('SELECT r.id, r.sku, s.name AS source, r.location, r.batch_no, r.manuf_date, r.qty_system, r.lot_id FROM inventory_rows r JOIN sources s ON s.id = r.source_id')).map((r) => ({
    id: r.id as number, sku: str(r.sku), source: str(r.source), location: str(r.location), batch_no: str(r.batch_no),
    manuf_date: str(r.manuf_date), qty_system: Number(r.qty_system) || 0, lot_id: (r.lot_id as number | null) ?? null,
  }))
  const picks = (await query('SELECT * FROM picks WHERE period IS NULL AND lot_id IS NULL')).map((r) => ({
    id: r.id as number, sku: str(r.sku), description: str(r.description), source: str(r.source), location: str(r.location),
    batch_no: str(r.batch_no), uom: str(r.uom), qty: Number(r.qty) || 0, order_no: r.order_no == null ? null : String(r.order_no),
    picked_at: str(r.picked_at), note: str(r.note), pick_order_id: (r.pick_order_id as number | null) ?? null,
    lot_id: null, period: null,
  }))
  const srcs = await query('SELECT name, loaded_at, period FROM sources')
  const [{ n: counter }] = await query('SELECT n FROM lot_counter WHERE id = 1')
  const plan = planLotMigration({
    rows, picks, counter: Number(counter) || 0,
    loadedAt: Object.fromEntries(srcs.map((s) => [str(s.name), str(s.loaded_at)])),
    currentPeriod: Object.fromEntries(srcs.map((s) => [str(s.name), Number(s.period) || 1])),
  })
  if (plan.statements.length) await batch(plan.statements)
}

const toSource =(r: Record<string, unknown>): Source => ({
  id: r.id as number,
  name: r.name as string,
  sheet: (r.sheet as string) ?? '',
  header_row: (r.header_row as number) ?? 0,
  header_rows: (r.header_rows as number) ?? 1,
  mapping: JSON.parse((r.mapping as string) || '{}'),
  file_name: (r.file_name as string) ?? '',
  loaded_at: (r.loaded_at as string) ?? '',
  row_count: (r.row_count as number) ?? 0,
  skipped: (r.skipped as string) ?? '',
  period: Number(r.period) || 1,
})

export async function listSources(): Promise<Source[]> {
  await initSchema()
  return (await query('SELECT * FROM sources ORDER BY name')).map(toSource)
}

/** Tạo hoặc cập nhật hồ sơ nguồn (khoá theo tên); trả về id. */
export async function saveSource(s: SourceInput): Promise<number> {
  await initSchema()
  await query(
    `INSERT INTO sources (name, sheet, header_row, header_rows, mapping) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET sheet = excluded.sheet, header_row = excluded.header_row,
       header_rows = excluded.header_rows, mapping = excluded.mapping`,
    [s.name, s.sheet, s.header_row, s.header_rows, JSON.stringify(s.mapping)],
  )
  const [row] = await query('SELECT id FROM sources WHERE name = ?', [s.name])
  return row.id as number
}

/** Nạp file mới = mở kỳ mới của nguồn: period+1, lot_id mới; picks/sửa cũ giữ nguyên (kỳ cũ). */
export async function replaceRows(sourceId: number, rows: StdRow[], meta: { file_name: string; skipped: string }) {
  await initSchema()
  await batch(replaceRowsSql(sourceId, STD_FIELDS, rows.map((r) => STD_FIELDS.map((f) => r[f] as string | number | null)), meta))
}

/** Số lần lấy và số thao tác sửa/nhập của kỳ hiện tại một nguồn (cho cảnh báo trước khi nạp). */
export async function getPeriodActivity(src: Source): Promise<{ picks: number; edits: number }> {
  await initSchema()
  const picks = await query('SELECT source, period, picked_at FROM picks WHERE source = ?', [src.name])
  const edits = await query('SELECT source, at FROM inventory_edits WHERE source = ?', [src.name])
  return countPeriodActivity(
    { name: src.name, period: src.period, loaded_at: src.loaded_at },
    picks.map((p) => ({ source: p.source as string | null, period: (p.period as number | null) ?? null, picked_at: p.picked_at as string | null })),
    edits.map((e) => ({ source: String(e.source ?? ''), at: String(e.at ?? '') })),
  )
}

/** Nạp file khối lượng: thay hoàn toàn bảng cũ. */
export async function replaceSkuWeights(rows: WeightRow[]) {
  await initSchema()
  await batch([
    { sql: 'DELETE FROM sku_weight' },
    ...rows.map((r) => ({ sql: 'INSERT OR REPLACE INTO sku_weight (sku_key, sku, weight_kg) VALUES (?, ?, ?)', bind: [r.key, r.sku, r.weight_kg] })),
  ])
}

/** Map sku_key (weightKey) -> kg. */
export async function getSkuWeights(): Promise<Map<string, number>> {
  await initSchema()
  const rows = await query('SELECT sku_key, weight_kg FROM sku_weight')
  return new Map(rows.map((r) => [r.sku_key as string, r.weight_kg as number]))
}

export async function deleteSource(id: number) {
  await initSchema()
  await batch([
    { sql: 'DELETE FROM inventory_rows WHERE source_id = ?', bind: [id] },
    { sql: 'DELETE FROM sources WHERE id = ?', bind: [id] },
  ])
}

export async function getRows(sourceId: number): Promise<InvRow[]> {
  await initSchema()
  return (await query('SELECT * FROM inventory_rows WHERE source_id = ?', [sourceId])) as unknown as InvRow[]
}

export type SkuHit = { sku: string; description: string }

/** Gợi ý khi gõ SKU: khớp đầu mã trước, rồi khớp chứa mã/tên hàng. */
export async function searchSkus(term: string, limit = 8): Promise<SkuHit[]> {
  await initSchema()
  const t = term.trim()
  if (!t) return []
  const esc = t.replace(/[!%_]/g, '!$&')
  return (await query(
    `SELECT sku, MIN(description) AS description FROM inventory_rows
     WHERE sku LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!'
     GROUP BY sku
     ORDER BY (sku LIKE ? ESCAPE '!') DESC, sku LIMIT ?`,
    [`%${esc}%`, `%${esc}%`, `${esc}%`, limit],
  )) as SkuHit[]
}

export type SkuRow = InvRow & { source: string; lot_id: number | null }

export async function getRowsBySku(sku: string): Promise<SkuRow[]> {
  await initSchema()
  return (await query(
    `SELECT r.*, s.name AS source FROM inventory_rows r JOIN sources s ON s.id = r.source_id
     WHERE r.sku = ? ORDER BY s.name, r.location, r.batch_no`,
    [sku],
  )) as unknown as SkuRow[]
}

// ---------- ĐVT ----------

export async function getUomMap(): Promise<Record<string, string>> {
  await initSchema()
  const rows = await query('SELECT key, label FROM uom_map')
  return Object.fromEntries(rows.map((r) => [r.key as string, r.label as string]))
}

export async function setUom(key: string, label: string) {
  await initSchema()
  await query('INSERT INTO uom_map (key, label) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET label = excluded.label', [key, label])
}

export async function deleteUom(key: string) {
  await initSchema()
  await query('DELETE FROM uom_map WHERE key = ?', [key])
}

export async function distinctUomRaw(): Promise<string[]> {
  await initSchema()
  return (await query(`SELECT DISTINCT uom_raw FROM inventory_rows WHERE uom_raw <> ''`)).map((r) => r.uom_raw as string)
}

const toCustomer = (r: Record<string, unknown>): Customer => normalizeCustomer(r as Partial<Customer>)

export async function listCustomers(): Promise<Customer[]> {
  await initSchema()
  return (await query('SELECT * FROM customers ORDER BY name COLLATE NOCASE, code')).map(toCustomer)
}

/** Thêm khách mới. Trả thông báo lỗi (trùng mã, thiếu trường) hoặc null nếu thành công. */
export async function addCustomer(input: Partial<Customer>): Promise<string | null> {
  await initSchema()
  const c = normalizeCustomer(input)
  const existing = (await query('SELECT code FROM customers')).map((r) => String(r.code))
  const err = validateCustomer(c, existing)
  if (err) return err
  await batch([{ sql: `INSERT INTO customers (code_key, ${CUSTOMER_FIELDS.join(', ')}) VALUES (?, ${CUSTOMER_FIELDS.map(() => '?').join(', ')})`, bind: [customerKey(c.code), ...CUSTOMER_FIELDS.map((f) => c[f])] }])
  return null
}

/** Sửa khách (giữ nguyên mã). Trả lỗi hoặc null. */
export async function updateCustomer(code: string, input: Partial<Customer>): Promise<string | null> {
  await initSchema()
  const c = normalizeCustomer({ ...input, code })
  const err = validateCustomer(c, [])
  if (err) return err
  const sets = CUSTOMER_FIELDS.filter((f) => f !== 'code')
  await batch([{ sql: `UPDATE customers SET ${sets.map((f) => `${f} = ?`).join(', ')} WHERE code_key = ?`, bind: [...sets.map((f) => c[f]), customerKey(code)] }])
  return null
}

/** Xoá khách; PK đang dùng mã này giữ nguyên mã chữ. */
export async function deleteCustomer(code: string) {
  await initSchema()
  await batch([{ sql: 'DELETE FROM customers WHERE code_key = ?', bind: [customerKey(code)] }])
}

// ---------- Sửa / di chuyển / tách / gộp dòng tồn ----------

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Đổi EditOp thành câu SQL; tên cột lấy từ STD_FIELDS (không nối chuỗi từ ngoài). */
type SqlBind = (string | number | null)[]
export function editOpsToSql(ops: EditOp[]): { sql: string; bind?: SqlBind }[] {
  const cols = new Set<string>(STD_FIELDS)
  return ops.flatMap((o): { sql: string; bind?: SqlBind }[] => {
    if (o.op === 'delete') return [{ sql: 'DELETE FROM inventory_rows WHERE id = ?', bind: [o.id] }]
    if (o.op === 'repoint_picks') return [{ sql: 'UPDATE picks SET lot_id = ? WHERE lot_id = ?', bind: [o.to, o.from] }]
    if (o.op === 'insert') {
      // lot_id mới: tăng lot_counter (không tái dùng) rồi lấy giá trị, trong cùng giao dịch
      const c = ['source_id', ...STD_FIELDS, 'lot_id']
      return [
        { sql: 'UPDATE lot_counter SET n = n + 1 WHERE id = 1' },
        { sql: `INSERT INTO inventory_rows (${c.join(',')}) VALUES (?,${STD_FIELDS.map(() => '?').join(',')},(SELECT n FROM lot_counter WHERE id = 1))`, bind: [o.source_id, ...STD_FIELDS.map((f) => o.row[f])] as SqlBind },
      ]
    }
    const keys = Object.keys(o.set).filter((k) => cols.has(k)) as StdField[]
    return [{ sql: `UPDATE inventory_rows SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, bind: [...keys.map((k) => o.set[k] ?? null), o.id] as SqlBind }]
  })
}

export const editLogSql = (log: EditLog, at = nowStamp()) => ({
  sql: 'INSERT INTO inventory_edits (at, kind, sku, source, before, after) VALUES (?, ?, ?, ?, ?, ?)',
  bind: [at, log.kind, log.sku, log.source, JSON.stringify(log.before), JSON.stringify(log.after)],
})

/** Áp một kế hoạch (từ planEdit/Move/Split/Merge): thao tác dòng + 1 dòng nhật ký trong một giao dịch. */
export async function applyEditPlan(plan: EditPlan): Promise<void> {
  if (!plan.ok) throw new Error(plan.error)
  await initSchema()
  await batch([...editOpsToSql(plan.ops), editLogSql(plan.log)])
}

/** Áp phiếu nhập (từ planReceive): mọi thao tác dòng + mỗi SKU một dòng nhật ký, trong một giao dịch. */
export async function applyReceivePlan(plan: ReceivePlan): Promise<void> {
  if (!plan.ok) throw new Error(plan.error)
  await initSchema()
  const at = nowStamp()
  await batch([...editOpsToSql(plan.ops), ...plan.logs.map((l) => editLogSql(l, at))])
  // GĐ0: ghi sổ cái RECEIVE cho phần tăng thêm của từng dòng (delta after - before theo id dòng;
  // dòng mới insert không có id trong before -> delta = toàn bộ qty, lot_id chưa rõ -> null).
  // Balances của ledger chạy song song để đối chiếu, UI hiện tại chưa đọc balances nên
  // hành vi hiển thị tồn (ước tính theo file) không đổi.
  for (const log of plan.logs) {
    for (const after of log.after) {
      const before = after.id != null ? log.before.find((b) => b.id === after.id) : undefined
      const delta = Math.round(((after.qty ?? 0) - (before?.qty ?? 0)) * 1e6) / 1e6
      if (!(delta > 0)) continue
      await recordMovement(
        { query: dbQuery, batch: dbBatch },
        {
          type: 'RECEIVE', warehouse_id: null, location_id: null,
          lot_id: after.lot_id ?? before?.lot_id ?? null, sku: log.sku, qty: delta,
          doc_type: 'RECEIPT', actor: 'local', note: `Nhập tay từ nguồn ${log.source}`,
        },
      )
    }
  }
}

export interface InventoryEdit { id: number; at: string; kind: string; sku: string; source: string; before: unknown; after: unknown }

const parseJson = (v: unknown) => { try { return JSON.parse(String(v ?? 'null')) } catch { return null } }

/** Nhật ký thao tác, mới nhất trước. */
export async function listInventoryEdits(limit = 200): Promise<InventoryEdit[]> {
  await initSchema()
  return (await query('SELECT * FROM inventory_edits ORDER BY at DESC, id DESC LIMIT ?', [limit])).map((r) => ({
    id: r.id as number, at: String(r.at ?? ''), kind: String(r.kind ?? ''), sku: String(r.sku ?? ''), source: String(r.source ?? ''),
    before: parseJson(r.before), after: parseJson(r.after),
  }))
}
