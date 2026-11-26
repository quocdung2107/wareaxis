// Danh mục lý do điều chỉnh tồn (seed cho bảng adjustment_reasons — kế hoạch Phần 5.3E).
// Mọi movement ADJUST_* / DAMAGE / WRITE_OFF phải mang một mã trong danh mục này
// (hoặc mã đã thêm vào DB của kho); mã không có trong danh mục bị apply.ts từ chối.

export interface AdjustmentReason {
  code: string
  name: string
  /** true = cần người có quyền duyệt (KHO_ADMIN) mới áp được ở tầng nghiệp vụ. */
  requires_approval: boolean
}

export const ADJUSTMENT_REASONS: readonly AdjustmentReason[] = [
  { code: 'COUNT_VARIANCE', name: 'Chênh lệch kiểm kê', requires_approval: true },
  { code: 'DAMAGED', name: 'Hàng hỏng / vỡ', requires_approval: false },
  { code: 'EXPIRED', name: 'Hết hạn dùng', requires_approval: false },
  { code: 'LOST', name: 'Thất lạc / mất hàng', requires_approval: true },
  { code: 'FOUND', name: 'Tìm thấy hàng (tăng tồn)', requires_approval: true },
  { code: 'INPUT_ERROR', name: 'Sai sót nhập liệu', requires_approval: false },
  { code: 'RETURN_QC', name: 'Hàng trả không đạt kiểm tra', requires_approval: false },
  // GĐ3: lý do đóng băng (FREEZE) — FREEZE không thuộc nhóm REASON_REQUIRED của
  // ledger, nhưng tầng nghiệp vụ ops/freeze bắt buộc chọn một mã trong danh mục.
  { code: 'QUALITY_HOLD', name: 'Đóng băng chờ kiểm tra chất lượng', requires_approval: false },
  { code: 'DAMAGE_SUSPECT', name: 'Nghi hỏng — đóng băng chờ xử lý', requires_approval: false },
] as const

export const REASON_CODES: ReadonlySet<string> = new Set(ADJUSTMENT_REASONS.map((r) => r.code))

export const reasonByCode = (code: string): AdjustmentReason | undefined =>
  ADJUSTMENT_REASONS.find((r) => r.code === code)
