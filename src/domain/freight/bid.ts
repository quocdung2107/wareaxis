// Chào giá (Bid) — T2, logic thuần, không DB.
// Nguồn thiết kế: thiet-ke-lai-tai-khoan-va-t2-chao-gia.md Phần 3.
// Bid là ĐỀ NGHỊ chủ động của nhà xe cho một tải đang mở chào giá:
// giá + xe/tài xế dự kiến + giờ có thể lấy hàng + hạn hiệu lực.
// Vòng đời: PENDING -> ACCEPTED (chủ tải chốt — sinh booking BOOKED),
// PENDING -> REJECTED (chủ tải từ chối, hoặc thua bid thắng với
// closed_reason 'lost'), PENDING -> WITHDRAWN (nhà xe tự rút),
// PENDING -> EXPIRED (quá hạn hiệu lực — đóng lười phía server).
// Sửa giá = cập nhật CHÍNH bid PENDING đó (không tạo bid mới) và ghi
// lịch sử — một (tải, tài khoản nhà xe) tối đa MỘT bid đang hiệu lực.
// Máy trạng thái TẢI không thêm trạng thái BIDDING (quyết định có chủ
// đích ở thiết kế 3.6): "đang có chào giá" là hiển thị suy ra từ dữ
// liệu (tải POSTED + có bid PENDING), không phải trạng thái vòng đời.
import type { BookingSide } from './booking.ts'
import type { LoadVisibility } from './load.ts'

export const BID_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as const
export type BidStatus = (typeof BID_STATUSES)[number]

export const BID_STATUS_LABELS: Record<BidStatus, string> = {
  PENDING: 'Đang chờ chủ tải',
  ACCEPTED: 'Đã thắng — đã chốt chuyến',
  REJECTED: 'Chủ tải từ chối / thua chào giá khác',
  WITHDRAWN: 'Đã rút giá',
  EXPIRED: 'Hết hạn hiệu lực',
}

/** Lý do đóng bid (closed_reason) -> nhãn hiển thị. */
export const BID_CLOSED_REASON_LABELS: Record<string, string> = {
  lost: 'Thua chào giá được chốt',
  expired: 'Hết hạn hiệu lực',
  load_cancelled: 'Tải đã huỷ',
  rejected_by_shipper: 'Chủ tải từ chối',
}

const TRANSITIONS: Partial<Record<BidStatus, readonly BidStatus[]>> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
}

/** Mọi trạng thái ngoài PENDING đều là kết thúc — không chuyển tiếp được nữa. */
export function canTransitionBid(from: BidStatus, to: BidStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Phía nào được thực hiện một chuyển đổi của bid:
 *   ACCEPTED / REJECTED — chỉ chủ tải (SHIPPER) của tải chứa bid;
 *   WITHDRAWN / EXPIRED — phía nhà xe sở hữu bid (CARRIER); EXPIRED
 *   trong thực tế do hệ thống đóng lười, nhà xe chỉ "gây ra" bằng cách
 *   chạm vào bid đã quá hạn.
 * DRIVER không hành động trực tiếp trên bid.
 */
export function bidTransitionSides(from: BidStatus, to: BidStatus): readonly BookingSide[] {
  if (!canTransitionBid(from, to)) return []
  if (to === 'ACCEPTED' || to === 'REJECTED') return ['SHIPPER']
  return ['CARRIER']
}

export function canSideTransitionBid(from: BidStatus, to: BidStatus, side: BookingSide): boolean {
  return bidTransitionSides(from, to).includes(side)
}

/** Bid còn đang hiệu lực (chờ chốt) tại thời điểm `now` chưa? */
export function isBidLive(status: BidStatus, expiresAt: string, now: Date = new Date()): boolean {
  return status === 'PENDING' && new Date(expiresAt).getTime() > now.getTime()
}

/**
 * Bid đã quá hạn hiệu lực nhưng còn mang trạng thái PENDING (đóng lười
 * phía server chưa kịp chạy) — UI hiển thị như EXPIRED và mọi thao tác
 * chốt/sửa/rút trên nó đều bị RPC từ chối bằng mã bid_expired.
 */
export function isBidStale(status: BidStatus, expiresAt: string, now: Date = new Date()): boolean {
  return status === 'PENDING' && new Date(expiresAt).getTime() <= now.getTime()
}

/** Trạng thái HIỂN THỊ của bid sau khi áp đóng lười phía client. */
export function effectiveBidStatus(status: BidStatus, expiresAt: string, now: Date = new Date()): BidStatus {
  return isBidStale(status, expiresAt, now) ? 'EXPIRED' : status
}

// ----- Quy tắc mở chào giá theo mức hiển thị (thiết kế 3.4) -----

/**
 * Giá trị MẶC ĐỊNH của open_for_bids khi tạo tải:
 *   DIRECT  -> false (chỉ định là đường chốt chính; chủ tải chủ động
 *              bật thì chỉ tài khoản được chỉ định mới chào giá được);
 *   NETWORK / PUBLIC -> true (chủ tải tắt được trong dialog đăng tải).
 */
export function defaultOpenForBids(visibility: LoadVisibility): boolean {
  return visibility !== 'DIRECT'
}

/**
 * Một tài khoản nhà xe có ĐƯỢC đặt bid cho tải này không, ở tầng
 * domain (RPC freight_acct_place_bid kiểm tra lại đầy đủ phía server):
 *   - không tự đặt bid cho tải của chính mình (own_load — tự vận
 *     chuyển đi đường chỉ định trực tiếp);
 *   - phải có vai trò vận tải;
 *   - tải phải bật open_for_bids và đang POSTED;
 *   - phải THẤY ĐƯỢC tải (canSeeLoad ở account.ts — hàm này nhận sẵn
 *     kết quả `visible` để không trùng lặp quy tắc hiển thị).
 */
export interface BidEligibilityInput {
  me: string
  posterAccountId: string | null | undefined
  isCarrier: boolean
  loadStatus: string
  openForBids: boolean
  visible: boolean
}

export type BidEligibility =
  | { ok: true }
  | { ok: false; code: 'own_load' | 'not_carrier' | 'load_not_open' | 'bidding_closed' | 'not_visible' }

export function bidEligibility(i: BidEligibilityInput): BidEligibility {
  if (i.posterAccountId && i.posterAccountId === i.me) return { ok: false, code: 'own_load' }
  if (!i.isCarrier) return { ok: false, code: 'not_carrier' }
  if (i.loadStatus !== 'POSTED') return { ok: false, code: 'load_not_open' }
  if (!i.openForBids) return { ok: false, code: 'bidding_closed' }
  if (!i.visible) return { ok: false, code: 'not_visible' }
  return { ok: true }
}

// ----- Validate đầu vào đặt/sửa chào giá -----

export interface BidInput {
  bid_price: number | null | undefined
  /** Hạn hiệu lực (ISO) — không bắt buộc; để trống thì server áp mặc định. */
  expires_at?: string | null
  /** Giờ có thể đến lấy hàng (ISO) — không bắt buộc. */
  eta_pickup_at?: string | null
  /** Xe/tài xế dự kiến — không bắt buộc (gán sau vẫn được). */
  proposed_vehicle_id?: string | null
  proposed_driver_id?: string | null
}

/**
 * Validate MỀM cho chào giá: giá bắt buộc và > 0 (giá là chính nội
 * dung của đề nghị); hạn hiệu lực nếu khai phải ở TƯƠNG LAI — đây là
 * hạn của một đề nghị thương lượng do CHÍNH người chào tự đặt, chặn
 * một chào giá sinh ra đã hết hạn là toàn vẹn dữ liệu (thiết kế 3.6),
 * không liên quan hạn giấy tờ bên thứ ba. Xe/tài xế dự kiến và giờ
 * lấy hàng không bắt buộc.
 * Trả danh sách lỗi (rỗng = hợp lệ).
 */
export function validateBidInput(i: BidInput, now: Date = new Date()): string[] {
  const errs: string[] = []
  if (i.bid_price == null || !Number.isFinite(i.bid_price)) errs.push('Cần nhập giá chào.')
  else if (!(i.bid_price > 0)) errs.push('Giá chào phải lớn hơn 0.')
  if (i.expires_at) {
    const t = new Date(i.expires_at).getTime()
    if (Number.isNaN(t)) errs.push('Hạn hiệu lực chào giá không hợp lệ.')
    else if (t <= now.getTime()) errs.push('Hạn hiệu lực chào giá phải ở tương lai.')
  }
  if (i.eta_pickup_at && Number.isNaN(new Date(i.eta_pickup_at).getTime())) {
    errs.push('Giờ có thể lấy hàng không hợp lệ.')
  }
  return errs
}

/** Hạn hiệu lực mặc định phía client hiển thị trước: 72 giờ từ bây giờ. */
export function defaultBidExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + 72 * 3600 * 1000)
}
