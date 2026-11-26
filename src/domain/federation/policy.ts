// Chính sách chia sẻ liên kho (Federation, GĐ4 — kế hoạch v2 Phần 4B.4).
// Logic THUẦN, không DB, không React: dùng chung cho client (quản lý khoá) và
// được port sang Warehouse Server (server/src/index.js — bản JS phải giữ khớp).
//
// Nguyên tắc bất biến: tồn kho chỉ được ĐỌC ở mức truy vấn, không có CSDL tồn
// trung tâm; giá vốn KHÔNG chia sẻ theo mặc định — chỉ khi share_cost_price
// bật cho đúng khoá gọi vào mới kèm trường giá trong kết quả.

/** Ba công tắc chia sẻ của một khoá federation. */
export interface SharePolicy {
  share_available: boolean // chia sẻ tồn khả dụng theo SKU/lô
  share_low_stock: boolean // chia sẻ danh sách SKU dưới mức tồn tối thiểu
  share_cost_price: boolean // kèm giá vốn trong kết quả availability (mặc định TẮT)
}

export const DEFAULT_SHARE_POLICY: SharePolicy = {
  share_available: true,
  share_low_stock: false,
  share_cost_price: false,
}

/** Dòng availability thô ở kho bị truy vấn (có thể chứa trường giá nội bộ). */
export interface AvailabilityRowInput {
  sku: string
  lot_id?: number | null
  expiry_date?: string | null
  available: number
  unit_cost?: number | null
  cost_price?: number | null
  purchase_price?: number | null
  [key: string]: unknown
}

/** Dòng availability chuẩn hoá được phép rời khỏi kho. */
export interface AvailabilityRow {
  sku: string
  lot_id: number | null
  expiry_date: string | null
  available: number
  unit_cost?: number | null
  cost_price?: number | null
  purchase_price?: number | null
}

const COST_FIELDS = ['unit_cost', 'cost_price', 'purchase_price'] as const

/**
 * Áp chính sách chia sẻ lên các dòng availability thô:
 * - share_available tắt -> không chia sẻ gì (mảng rỗng).
 * - Chuẩn hoá mỗi dòng về đúng {sku, lot_id, expiry_date, available}.
 * - Trường giá vốn CHỈ đi kèm khi share_cost_price bật (và dòng có giá trị).
 */
export function applySharePolicy(
  rows: readonly AvailabilityRowInput[],
  policy: SharePolicy,
): AvailabilityRow[] {
  if (!policy.share_available) return []
  return rows.map((r) => {
    const out: AvailabilityRow = {
      sku: String(r.sku),
      lot_id: r.lot_id ?? null,
      expiry_date: r.expiry_date ?? null,
      available: Number(r.available) || 0,
    }
    if (policy.share_cost_price) {
      for (const f of COST_FIELDS) {
        const v = r[f]
        if (v != null && Number.isFinite(Number(v))) out[f] = Number(v)
      }
    }
    return out
  })
}

/** Cấu hình một kho peer trong cổng liên kho (portal). */
export interface PeerConfigInput {
  name?: unknown
  base_url?: unknown
  api_key?: unknown
}

/** Bỏ dấu / cuối của base_url để nối đường dẫn cho nhất quán. */
export function normalizeBaseUrl(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\/+$/, '')
}

/**
 * Kiểm tra cấu hình peer trước khi lưu vào portal. Trả danh sách lỗi
 * (rỗng = hợp lệ): tên không rỗng; base_url là URL http/https hợp lệ;
 * api_key không rỗng.
 */
export function validatePeerConfig(input: PeerConfigInput): string[] {
  const errors: string[] = []
  if (!String(input.name ?? '').trim()) errors.push('Tên kho peer không được để trống')
  const raw = String(input.base_url ?? '').trim()
  if (!raw) {
    errors.push('Địa chỉ (base_url) của kho peer không được để trống')
  } else {
    let u: URL | null = null
    try { u = new URL(raw) } catch { u = null }
    if (!u) errors.push('Địa chỉ (base_url) không phải URL hợp lệ')
    else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      errors.push('Địa chỉ (base_url) phải bắt đầu bằng http:// hoặc https://')
    }
  }
  if (!String(input.api_key ?? '').trim()) errors.push('Thiếu khoá liên kho (api_key) của kho peer')
  return errors
}
