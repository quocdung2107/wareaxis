// Tầng ghi/đọc cho Liên kho (Federation, GĐ4) trên SQLite local của app.
// Quản lý KHOÁ cấp cho bên ngoài gọi vào kho này + chính sách chia sẻ theo
// khoá + nhật ký truy vấn. Logic chính sách thuần ở src/domain/federation/.
//
// An toàn khoá: khoá plaintext chỉ tồn tại đúng 1 lần khi tạo (trả về cho UI
// hiển thị + sao chép); DB chỉ lưu SHA-256 hash (cột key_hash) — giống hệt
// cách Warehouse Server lưu. Thu hồi khoá = active 0, không xoá dòng (audit).
import { batch, query } from '../db/client.ts'
import { initSchema } from './repo.ts'
import {
  DEFAULT_SHARE_POLICY, validatePeerConfig,
  type SharePolicy,
} from '../../domain/federation/policy.ts'

const nowStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (v == null ? '' : String(v))

// ---------- Khoá liên kho ----------
export interface FederationKey {
  id: number
  name: string
  policy: SharePolicy
  active: boolean
  created_at: string
  created_by: string
  revoked_at: string
  last_used_at: string
}

const rowToKey = (r: Record<string, unknown>): FederationKey => ({
  id: num(r.id),
  name: str(r.name),
  policy: {
    share_available: num(r.share_available) === 1,
    share_low_stock: num(r.share_low_stock) === 1,
    share_cost_price: num(r.share_cost_price) === 1,
  },
  active: num(r.active) === 1,
  created_at: str(r.created_at),
  created_by: str(r.created_by),
  revoked_at: str(r.revoked_at),
  last_used_at: str(r.last_used_at),
})

/** SHA-256 hex bằng WebCrypto (trình duyệt) — cùng thuật toán phía server. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Sinh khoá plaintext mới: tiền tố fed_ + 24 byte ngẫu nhiên dạng hex. */
export function generateFederationKeyPlaintext(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `fed_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export async function listFederationKeys(): Promise<FederationKey[]> {
  await initSchema()
  const rows = await query('SELECT * FROM federation_keys ORDER BY id')
  return rows.map(rowToKey)
}

/**
 * Tạo khoá mới: trả plaintext ĐÚNG 1 lần kèm bản ghi đã lưu (chỉ có hash).
 * Người gọi (UI) phải hiển thị plaintext ngay, không có cách lấy lại sau.
 */
export async function createFederationKey(
  name: string,
  policy: SharePolicy = DEFAULT_SHARE_POLICY,
  actor = 'local',
): Promise<{ key: FederationKey; plaintext: string }> {
  await initSchema()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Khoá liên kho cần có tên (ví dụ: tên portal/kho được cấp)')
  const plaintext = generateFederationKeyPlaintext()
  const hash = await sha256Hex(plaintext)
  const at = nowStamp()
  await batch([{
    sql: `INSERT INTO federation_keys (name, key_hash, share_available, share_low_stock, share_cost_price, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bind: [trimmed, hash, policy.share_available ? 1 : 0, policy.share_low_stock ? 1 : 0, policy.share_cost_price ? 1 : 0, at, actor],
  }])
  const [{ id }] = await query('SELECT last_insert_rowid() AS id')
  const [row] = await query('SELECT * FROM federation_keys WHERE id = ?', [num(id)])
  return { key: rowToKey(row), plaintext }
}

export async function revokeFederationKey(id: number): Promise<void> {
  await initSchema()
  await batch([{
    sql: 'UPDATE federation_keys SET active = 0, revoked_at = ? WHERE id = ? AND active = 1',
    bind: [nowStamp(), id],
  }])
}

export async function updateFederationKeyPolicy(id: number, policy: SharePolicy): Promise<FederationKey> {
  await initSchema()
  await batch([{
    sql: 'UPDATE federation_keys SET share_available = ?, share_low_stock = ?, share_cost_price = ? WHERE id = ?',
    bind: [policy.share_available ? 1 : 0, policy.share_low_stock ? 1 : 0, policy.share_cost_price ? 1 : 0, id],
  }])
  const [row] = await query('SELECT * FROM federation_keys WHERE id = ?', [id])
  if (!row) throw new Error('Không tìm thấy khoá liên kho')
  return rowToKey(row)
}

// ---------- Nhật ký truy vấn ----------
export interface FederationQueryLog {
  id: number
  peer_warehouse_code: string
  query_type: string
  sku: string
  requested_by: string
  result_status: string
  created_at: string
}

export async function listFederationQueryLogs(limit = 100): Promise<FederationQueryLog[]> {
  await initSchema()
  const rows = await query('SELECT * FROM federation_query_logs ORDER BY id DESC LIMIT ?', [limit])
  return rows.map((r) => ({
    id: num(r.id),
    peer_warehouse_code: str(r.peer_warehouse_code),
    query_type: str(r.query_type),
    sku: str(r.sku),
    requested_by: str(r.requested_by),
    result_status: str(r.result_status),
    created_at: str(r.created_at),
  }))
}

// ---------- Cổng liên kho (portal chạy trên Warehouse Server) ----------
/** Validate cấu hình peer bằng domain thuần — dùng cho ô nhập địa chỉ mở portal. */
export function validatePortalPeer(input: { name: string; base_url: string; api_key: string }): string[] {
  return validatePeerConfig(input)
}

/** Địa chỉ trang portal từ địa chỉ máy chủ người dùng nhập (host hoặc URL đầy đủ). */
export function portalUrl(serverAddress: string): string {
  const raw = serverAddress.trim().replace(/\/+$/, '')
  if (!raw) return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const u = new URL(withScheme)
    if (!u.port) u.port = '8787'
    return `${u.origin}/portal`
  } catch {
    return ''
  }
}
