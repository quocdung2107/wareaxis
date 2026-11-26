// Vai trò local tại kho (kế hoạch Phần 4B.3) + ma trận quyền {resource}_{action}.
// Đây là nguồn sự thật phía frontend/standalone; Warehouse Server (server/)
// cài lại cùng ma trận này bằng JS thuần — khi sửa ở đây phải sửa ở server.

export const LOCAL_ROLES = [
  'KHO_ADMIN', // quản trị kho tại máy trung tâm
  'THU_KHO', // thủ kho
  'NV_LAY_HANG', // nhân viên lấy hàng (pick)
  'NV_NHAN_HANG', // nhân viên nhận hàng / QC
  'KE_TOAN_XEM', // kế toán kho — chỉ xem
] as const

export type LocalRole = (typeof LOCAL_ROLES)[number]

export const ROLE_LABELS: Record<LocalRole, string> = {
  KHO_ADMIN: 'Quản trị kho',
  THU_KHO: 'Thủ kho',
  NV_LAY_HANG: 'Nhân viên lấy hàng',
  NV_NHAN_HANG: 'Nhân viên nhận hàng',
  KE_TOAN_XEM: 'Kế toán kho (chỉ xem)',
}

/** Toàn bộ quyền trong hệ thống kho, dạng {resource}_{action}. */
export const PERMISSIONS = [
  'inventory_view', // xem tồn / tra SKU
  'inventory_receive', // nhận hàng (receiving)
  'inventory_putaway', // cất hàng vào vị trí
  'inventory_pick', // lấy hàng theo task/đơn PK
  'inventory_count', // kiểm kê
  'inventory_adjust', // điều chỉnh / đóng băng / xuất hủy (vẫn cần reason_code)
  'inventory_transfer', // chuyển vị trí / chuyển kho
  'purchase_create', // tạo đơn mua PO / phiếu nhập dự kiến
  'purchase_receive', // nhận hàng theo PO + QC (GĐ1)
  'outbound_allocate', // tạo đơn xuất + phân bổ tồn + huỷ đơn (GĐ2)
  'outbound_pick', // tạo wave + xác nhận lấy hàng (GĐ2)
  'outbound_pack', // đóng gói kiểm chứng (GĐ2)
  'outbound_ship', // giao hàng / tạo phiếu giao (GĐ2)
  'returns_receive', // nhận hàng khách trả về (GĐ2)
  'reports_view', // xem báo cáo / thẻ kho
  'users_manage', // quản lý tài khoản local
  'devices_manage', // duyệt / thu hồi thiết bị
  'backup_manage', // tạo & khôi phục sao lưu
  'federation_manage', // cấu hình liên kho
  'webhooks_manage', // cấu hình webhook trạng thái (GĐ5) — chỉ KHO_ADMIN (qua ALL)
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ALL: readonly Permission[] = PERMISSIONS

/** Ma trận quyền theo vai trò. KE_TOAN_XEM chỉ có quyền *_view — không ghi được gì. */
export const ROLE_PERMISSIONS: Record<LocalRole, readonly Permission[]> = {
  KHO_ADMIN: ALL,
  THU_KHO: [
    'inventory_view', 'inventory_receive', 'inventory_putaway', 'inventory_pick',
    'inventory_count', 'inventory_adjust', 'inventory_transfer',
    'purchase_create', 'purchase_receive',
    'outbound_allocate', 'outbound_pick', 'outbound_pack', 'outbound_ship', 'returns_receive',
    'reports_view',
  ],
  NV_LAY_HANG: ['inventory_view', 'inventory_pick', 'outbound_pick', 'outbound_pack'],
  NV_NHAN_HANG: ['inventory_view', 'inventory_receive', 'inventory_putaway', 'purchase_receive', 'returns_receive'],
  KE_TOAN_XEM: ['inventory_view', 'reports_view'],
}

export const isLocalRole = (v: unknown): v is LocalRole =>
  typeof v === 'string' && (LOCAL_ROLES as readonly string[]).includes(v)
