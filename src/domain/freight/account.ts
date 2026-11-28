// Mô hình danh tính THEO TÀI KHOẢN (R1) — logic thuần, không DB.
// Nguồn thiết kế: thiet-ke-lai-tai-khoan-va-t2-chao-gia.md Phần 1.
// Thay đổi cốt lõi so với T1: quyền sở hữu gắn với TÀI KHOẢN (auth.users),
// group chỉ còn là không gian trao đổi. Máy trạng thái Load/Booking ở
// load.ts / booking.ts GIỮ NGUYÊN — file này chỉ định nghĩa lại cách xác
// định CHỦ THỂ và PHÍA theo tài khoản, validate hồ sơ tài khoản, và quy
// tắc hiển thị tải theo tài khoản.
// Triết lý Bản A giữ nguyên: validate mềm (chỉ chặn rỗng/sai định dạng),
// TUYỆT ĐỐI không có rule nào về hạn giấy tờ.
import type { BookingSide } from './booking.ts'
import type { LoadVisibility } from './load.ts'
import { isPlausiblePhone } from './profile.ts'

// ----- Hồ sơ tài khoản (một dòng / tài khoản, hai vai trò độc lập) -----

export interface AccountProfileInput {
  display_name: string
  legal_name?: string | null
  tax_code?: string | null
  contact_name?: string | null
  contact_phone?: string | null
  address?: string | null
  province?: string | null
  /** Đã đăng ký vai trò CHỦ KHO / chủ hàng. */
  is_shipper: boolean
  /** Đã đăng ký vai trò VẬN TẢI (đội xe). */
  is_carrier: boolean
  /** Tự khai — chỉ dùng khi is_carrier. */
  business_license_no?: string | null
  /** Tự khai — chỉ dùng khi is_carrier. */
  capability_note?: string | null
}

/**
 * Validate mềm cho hồ sơ tài khoản: tên hiển thị bắt buộc; ít nhất một
 * trong hai vai trò phải bật (một tài khoản được giữ CẢ HAI vai — chủ
 * kho kiêm vận tải là trường hợp hợp lệ, điểm đã chốt 1); MST/SĐT chỉ
 * kiểm tra định dạng khi có khai. Không có rule về ngày tháng giấy tờ.
 */
export function validateAccountProfile(i: AccountProfileInput): string[] {
  const errs: string[] = []
  if (!i.display_name?.trim()) errs.push('Cần tên hiển thị của tài khoản.')
  if (!i.is_shipper && !i.is_carrier) {
    errs.push('Cần chọn ít nhất một vai trò: chủ kho hoặc vận tải.')
  }
  if (i.tax_code != null && i.tax_code.trim() !== '' && !/^[0-9][0-9-]{8,14}$/.test(i.tax_code.trim())) {
    errs.push('Mã số thuế (nếu khai) chỉ gồm số và dấu -, 9–15 ký tự.')
  }
  if (i.contact_phone != null && i.contact_phone.trim() !== '' && !isPlausiblePhone(i.contact_phone)) {
    errs.push('Số điện thoại liên hệ (nếu khai) chưa đúng định dạng.')
  }
  return errs
}

// ----- Kho của tài khoản -----

export interface WarehouseInput {
  name: string
  address: string
  province?: string | null
  contact_name?: string | null
  contact_phone?: string | null
  dock_count?: number | null
}

export function validateWarehouse(i: WarehouseInput): string[] {
  const errs: string[] = []
  if (!i.name?.trim()) errs.push('Cần tên kho.')
  if (!i.address?.trim()) errs.push('Cần địa chỉ kho.')
  if (i.contact_phone != null && i.contact_phone.trim() !== '' && !isPlausiblePhone(i.contact_phone)) {
    errs.push('Số điện thoại tại kho (nếu khai) chưa đúng định dạng.')
  }
  if (i.dock_count != null && !(i.dock_count >= 0)) errs.push('Số cửa xuất/nhập không được âm.')
  return errs
}

// ----- Phía của tài khoản đối với một chuyến (khớp freight_acct_actor_side) -----

/**
 * Xác định phía của tài khoản `me` đối với một chuyến theo TÀI KHOẢN:
 *   'SHIPPER' nếu me là phía chủ hàng;
 *   'DRIVER'  nếu me là tài khoản của một tài xế đang active thuộc đội
 *             xe của phía nhà xe (driverCarrierAccountIds chứa carrier);
 *   'CARRIER' nếu me là phía nhà xe;
 *   null nếu không liên quan.
 * Thứ tự ưu tiên SHIPPER -> DRIVER -> CARRIER khớp hàm SQL
 * freight_acct_actor_side. Trường hợp tự vận chuyển (shipper = carrier
 * = me) trả 'SHIPPER' — phía hành động còn lại được RPC advance phân
 * theo chuyển đổi cụ thể.
 */
export function accountActorSide(
  me: string,
  shipperAccountId: string | null | undefined,
  carrierAccountId: string | null | undefined,
  driverCarrierAccountIds: readonly string[] = [],
): BookingSide | null {
  if (!me) return null
  if (shipperAccountId && me === shipperAccountId) return 'SHIPPER'
  if (carrierAccountId && driverCarrierAccountIds.includes(carrierAccountId)) return 'DRIVER'
  if (carrierAccountId && me === carrierAccountId) return 'CARRIER'
  return null
}

/** Tự vận chuyển: cùng một tài khoản là cả chủ hàng lẫn nhà xe của chuyến. */
export const isSelfHaul = (
  me: string,
  shipperAccountId: string | null | undefined,
  carrierAccountId: string | null | undefined,
): boolean => !!me && shipperAccountId === me && carrierAccountId === me

// ----- Kết nối giữa hai tài khoản -----

export type AccountLinkStatus = 'PENDING' | 'ACCEPTED' | 'ENDED'

export interface AccountLinkLike {
  requester_account_id: string
  addressee_account_id: string
  status: AccountLinkStatus
}

/** Trạng thái kết nối giữa `me` và `other` nhìn từ phía `me`. */
export type LinkRelation = 'ACCEPTED' | 'PENDING_OUT' | 'PENDING_IN' | 'ENDED' | null

export function linkRelationWith(links: readonly AccountLinkLike[], me: string, other: string): LinkRelation {
  const l = links.find(
    (x) =>
      (x.requester_account_id === me && x.addressee_account_id === other) ||
      (x.requester_account_id === other && x.addressee_account_id === me),
  )
  if (!l) return null
  if (l.status === 'ACCEPTED') return 'ACCEPTED'
  if (l.status === 'ENDED') return 'ENDED'
  return l.requester_account_id === me ? 'PENDING_OUT' : 'PENDING_IN'
}

/** Hai tài khoản đã kết nối ACCEPTED với nhau chưa (bất kể chiều mời). */
export function isAccountLinked(links: readonly AccountLinkLike[], a: string, b: string): boolean {
  return links.some(
    (x) =>
      x.status === 'ACCEPTED' &&
      ((x.requester_account_id === a && x.addressee_account_id === b) ||
        (x.requester_account_id === b && x.addressee_account_id === a)),
  )
}

/** Tập tài khoản đã kết nối ACCEPTED với `me`. */
export function linkedAccountIds(links: readonly AccountLinkLike[], me: string): string[] {
  const out: string[] = []
  for (const l of links) {
    if (l.status !== 'ACCEPTED') continue
    if (l.requester_account_id === me) out.push(l.addressee_account_id)
    else if (l.addressee_account_id === me) out.push(l.requester_account_id)
  }
  return out
}

// ----- Quy tắc hiển thị tải theo tài khoản (khớp view freight_loads_discover) -----

export interface LoadVisibilityContext {
  me: string
  visibility: LoadVisibility
  posterAccountId: string | null | undefined
  directedAccountId?: string | null | undefined
  /** Các tài khoản đã kết nối ACCEPTED với me. */
  linkedIds: readonly string[]
  /** Các tài khoản cùng thuộc ít nhất một group trao đổi với me. */
  sameGroupAccountIds: readonly string[]
  /** Tải có được chủ tải chia sẻ vào một group mà me là thành viên không. */
  sharedToMyGroup?: boolean
}

/**
 * Một tài khoản có THẤY ĐƯỢC bản rút gọn của tải này không (Phần 1.5):
 *   - Chủ tải luôn thấy tải của mình.
 *   - PUBLIC: mọi tài khoản đã đăng nhập (giữ như T1).
 *   - DIRECT: chỉ tài khoản được chỉ định.
 *   - NETWORK: tài khoản đã kết nối ACCEPTED với chủ tải, HOẶC cùng
 *     group trao đổi với chủ tải (điểm đã chốt 2b).
 *   - Tải được chia sẻ vào group của mình: thấy ở mọi mức hiển thị.
 */
export function canSeeLoad(c: LoadVisibilityContext): boolean {
  if (c.posterAccountId && c.posterAccountId === c.me) return true
  if (c.sharedToMyGroup) return true
  switch (c.visibility) {
    case 'PUBLIC':
      return true
    case 'DIRECT':
      return !!c.directedAccountId && c.directedAccountId === c.me
    case 'NETWORK':
      if (!c.posterAccountId) return false
      return c.linkedIds.includes(c.posterAccountId) || c.sameGroupAccountIds.includes(c.posterAccountId)
    default:
      return false
  }
}
