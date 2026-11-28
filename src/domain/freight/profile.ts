// Hồ sơ tự khai (tổ chức / xe / tài xế / tuyến) — validate THUẦN HÌNH THỨC.
// Nguồn thiết kế: Bản A mục 0.2 + 2.2 + 3.5. Triết lý bắt buộc:
// LƯU Ý R1: ORG_TYPES / OrgProfileInput / validateOrgProfile là mô hình
// THEO GROUP của T1 — DEPRECATED, giữ lại cho client/dữ liệu cũ. Hồ sơ
// mới theo TÀI KHOẢN nằm ở account.ts (AccountProfileInput /
// validateAccountProfile). Validate xe/tài xế/tuyến trong file này vẫn
// dùng chung cho cả hai mô hình.
//   * Hồ sơ do đơn vị TỰ KHAI, hệ thống không xác thực, không duyệt.
//   * Ngày hết hạn giấy tờ (đăng kiểm / bảo hiểm / bằng lái) CHỈ để hiển thị
//     cho đối tác tự đánh giá. Validate ở đây TUYỆT ĐỐI không lỗi vì ngày
//     hết hạn nằm trong quá khứ — không tồn tại rule nào về hạn giấy tờ.
//   * Validate chỉ chặn rỗng / sai định dạng cơ bản để tránh dữ liệu rác.

/** Nhãn cố định hiển thị ở mọi màn hình hồ sơ đối tác (Bản A mục 0.2). */
export const SELF_DECLARED_LABEL = 'Thông tin do đơn vị tự khai — các bên tự xác minh khi giao dịch'

export const ORG_TYPES = ['SHIPPER', 'CARRIER', 'BOTH'] as const
export type OrgType = (typeof ORG_TYPES)[number]

export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  SHIPPER: 'Kho / chủ hàng',
  CARRIER: 'Nhà xe / vận tải',
  BOTH: 'Cả kho và vận tải',
}

export interface OrgProfileInput {
  org_type: OrgType
  display_name: string
  legal_name?: string | null
  tax_code?: string | null
  contact_name?: string | null
  contact_phone?: string | null
}

export function validateOrgProfile(i: OrgProfileInput): string[] {
  const errs: string[] = []
  if (!ORG_TYPES.includes(i.org_type)) errs.push('Loại tổ chức không hợp lệ.')
  if (!i.display_name?.trim()) errs.push('Cần tên hiển thị của đơn vị.')
  if (i.tax_code != null && i.tax_code.trim() !== '' && !/^[0-9][0-9-]{8,14}$/.test(i.tax_code.trim())) {
    errs.push('Mã số thuế (nếu khai) chỉ gồm số và dấu -, 9–15 ký tự.')
  }
  if (i.contact_phone != null && i.contact_phone.trim() !== '' && !isPlausiblePhone(i.contact_phone)) {
    errs.push('Số điện thoại liên hệ (nếu khai) chưa đúng định dạng.')
  }
  return errs
}

export interface VehicleInput {
  plate: string
  vehicle_type: string
  payload_kg?: number | null
  /** Ngày hết hạn đăng kiểm (tự khai) — CHỈ hiển thị, không validate hạn. */
  inspection_expires_at?: string | null
  /** Ngày hết hạn bảo hiểm (tự khai) — CHỈ hiển thị, không validate hạn. */
  insurance_expires_at?: string | null
}

export function validateVehicle(i: VehicleInput): string[] {
  const errs: string[] = []
  if (!i.plate?.trim()) errs.push('Cần biển số xe.')
  if (!i.vehicle_type?.trim()) errs.push('Cần loại xe.')
  if (i.payload_kg != null && !(i.payload_kg > 0)) errs.push('Tải trọng phải lớn hơn 0.')
  // Chỉ kiểm tra ĐỊNH DẠNG ngày nếu có khai; quá khứ hay tương lai đều hợp lệ.
  if (!isDateOrEmpty(i.inspection_expires_at)) errs.push('Ngày hết hạn đăng kiểm chưa đúng định dạng ngày.')
  if (!isDateOrEmpty(i.insurance_expires_at)) errs.push('Ngày hết hạn bảo hiểm chưa đúng định dạng ngày.')
  return errs
}

export interface DriverInput {
  full_name: string
  phone?: string | null
  license_class?: string | null
  /** Ngày hết hạn bằng lái (tự khai) — CHỈ hiển thị, không validate hạn. */
  license_expires_at?: string | null
}

export function validateDriver(i: DriverInput): string[] {
  const errs: string[] = []
  if (!i.full_name?.trim()) errs.push('Cần họ tên tài xế.')
  if (i.phone != null && i.phone.trim() !== '' && !isPlausiblePhone(i.phone)) {
    errs.push('Số điện thoại tài xế (nếu khai) chưa đúng định dạng.')
  }
  if (!isDateOrEmpty(i.license_expires_at)) errs.push('Ngày hết hạn bằng lái chưa đúng định dạng ngày.')
  return errs
}

export interface ServiceRouteInput {
  from_province: string
  to_province: string
  ref_price?: number | null
}

export function validateServiceRoute(i: ServiceRouteInput): string[] {
  const errs: string[] = []
  if (!i.from_province?.trim()) errs.push('Cần tỉnh/thành đi.')
  if (!i.to_province?.trim()) errs.push('Cần tỉnh/thành đến.')
  if (i.ref_price != null && i.ref_price < 0) errs.push('Giá tham chiếu không được âm.')
  return errs
}

/** SĐT plausible: chỉ số, khoảng trắng, dấu + đầu; 8–15 chữ số. */
export function isPlausiblePhone(v: string): boolean {
  const t = v.trim()
  if (!/^\+?[0-9\s.()-]+$/.test(t)) return false
  const digits = t.replace(/\D/g, '').length
  return digits >= 8 && digits <= 15
}

/** true nếu rỗng (không khai) hoặc là ngày YYYY-MM-DD hợp lệ — bất kể quá khứ/tương lai. */
export function isDateOrEmpty(v: string | null | undefined): boolean {
  if (v == null || v.trim() === '') return true
  const t = v.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false
  const d = new Date(`${t}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t
}
