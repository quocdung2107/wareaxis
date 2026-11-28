// Tải đăng tìm xe (Load) — logic thuần, không DB.
// Nguồn thiết kế: Bản A "Lớp trung gian giao tiếp Kho ↔ Vận tải" mục 2.2.7 + 2.6.
// Vòng đời: DRAFT -> POSTED -> ASSIGNED -> BOOKED; POSTED -> EXPIRED/CANCELLED;
// ASSIGNED -> POSTED (nhà xe từ chối chỉ định, tải mở lại);
// BOOKED -> POSTED (booking bị huỷ trước khi lấy hàng, tải mở lại);
// EXPIRED -> POSTED (đăng lại). T1 chưa có chào giá (Bid ở T2) nên không có
// trạng thái BIDDING trong máy này — sẽ bổ sung ở T2 cùng load_bids.

export const LOAD_STATUSES = ['DRAFT', 'POSTED', 'ASSIGNED', 'BOOKED', 'EXPIRED', 'CANCELLED'] as const
export type LoadStatus = (typeof LOAD_STATUSES)[number]

export const LOAD_STATUS_LABELS: Record<LoadStatus, string> = {
  DRAFT: 'Nháp',
  POSTED: 'Đang tìm xe',
  ASSIGNED: 'Đã chỉ định, chờ nhà xe xác nhận',
  BOOKED: 'Đã chốt chuyến',
  EXPIRED: 'Hết hạn đăng',
  CANCELLED: 'Đã huỷ',
}

export const LOAD_VISIBILITIES = ['DIRECT', 'NETWORK', 'PUBLIC'] as const
export type LoadVisibility = (typeof LOAD_VISIBILITIES)[number]

export const LOAD_VISIBILITY_LABELS: Record<LoadVisibility, string> = {
  DIRECT: 'Chỉ định nhà xe',
  NETWORK: 'Mạng lưới đã kết nối',
  PUBLIC: 'Công khai',
}

const TRANSITIONS: Record<LoadStatus, readonly LoadStatus[]> = {
  DRAFT: ['POSTED', 'CANCELLED'],
  POSTED: ['ASSIGNED', 'BOOKED', 'EXPIRED', 'CANCELLED'],
  ASSIGNED: ['BOOKED', 'POSTED', 'CANCELLED'],
  BOOKED: ['POSTED'],
  EXPIRED: ['POSTED', 'CANCELLED'],
  CANCELLED: [],
}

export function canTransitionLoad(from: LoadStatus, to: LoadStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function assertLoadTransition(from: LoadStatus, to: LoadStatus): void {
  if (!canTransitionLoad(from, to)) {
    throw new Error(`Không chuyển được tải từ ${LOAD_STATUS_LABELS[from] ?? from} sang ${LOAD_STATUS_LABELS[to] ?? to}`)
  }
}

/** Tải đang mở để nhà xe nhận/chỉ định (chưa có booking đang sống). */
export const isLoadOpen = (s: LoadStatus): boolean => s === 'POSTED'

export interface LoadInput {
  goods_desc: string
  weight_kg?: number | null
  packages?: number | null
  volume_m3?: number | null
  pickup_address?: string | null
  delivery_address?: string | null
  pickup_window_from?: string | null
  pickup_window_to?: string | null
  visibility: LoadVisibility
  /** T1 (theo group) — giữ để tương thích dữ liệu/RPC cũ. */
  directed_group_id?: string | null
  /** R1 (theo tài khoản): tài khoản nhà xe được chỉ định ở mức DIRECT. */
  directed_account_id?: string | null
  asking_price?: number | null
}

/**
 * Validate MỀM cho tải đăng: chỉ chặn rỗng/sai định dạng cơ bản (mô tả hàng
 * trống, số lượng âm, cửa sổ giờ ngược, DIRECT mà không chọn nhà xe).
 * Không có bất kỳ kiểm tra nào về giấy tờ/pháp lý — đúng triết lý Bản A.
 * Trả danh sách lỗi (rỗng = hợp lệ).
 */
export function validateLoadInput(i: LoadInput): string[] {
  const errs: string[] = []
  if (!i.goods_desc?.trim()) errs.push('Cần mô tả hàng hoá.')
  if (i.weight_kg != null && !(i.weight_kg > 0)) errs.push('Khối lượng phải lớn hơn 0.')
  if (i.packages != null && !(i.packages > 0)) errs.push('Số kiện phải lớn hơn 0.')
  if (i.volume_m3 != null && !(i.volume_m3 > 0)) errs.push('Thể tích phải lớn hơn 0.')
  if (i.asking_price != null && i.asking_price < 0) errs.push('Giá mong muốn không được âm.')
  if (!i.pickup_address?.trim() && !i.delivery_address?.trim()) errs.push('Cần ít nhất địa chỉ lấy hàng hoặc địa chỉ giao hàng.')
  if (i.pickup_window_from && i.pickup_window_to && i.pickup_window_from > i.pickup_window_to) {
    errs.push('Cửa sổ giờ lấy hàng không hợp lệ (từ > đến).')
  }
  if (i.visibility === 'DIRECT' && !i.directed_group_id && !i.directed_account_id) {
    errs.push('Mức "Chỉ định" cần chọn một nhà xe.')
  }
  return errs
}
