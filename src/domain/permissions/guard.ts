// Kiểm tra quyền tại điểm dùng (pattern require_role của akincenk + {resource}_{action}
// của QPOS — kế hoạch Phần 2.2 #10). Tầng API/server PHẢI gọi can() trước khi ghi;
// ẩn nút ở UI chỉ là hỗ trợ hiển thị, không phải bảo mật.
import { ROLE_PERMISSIONS, type LocalRole, type Permission } from './roles.ts'

/** true nếu vai trò có quyền. Vai trò/quyền không rõ -> false (fail closed). */
export function can(role: LocalRole | string | null | undefined, permission: Permission): boolean {
  if (!role) return false
  const perms = ROLE_PERMISSIONS[role as LocalRole]
  return perms ? perms.includes(permission) : false
}

/** Ném lỗi nếu thiếu quyền — dùng ở service/API. */
export function requirePermission(role: LocalRole | string | null | undefined, permission: Permission): void {
  if (!can(role, permission)) throw new Error(`Thiếu quyền ${permission}`)
}

/** Quyền ghi tương ứng cho từng loại movement khi áp qua API/server. */
export function permissionForMovement(type: string): Permission {
  switch (type) {
    case 'RECEIVE':
    case 'RETURN_IN':
      return 'inventory_receive'
    case 'PUTAWAY':
      return 'inventory_putaway'
    case 'ALLOCATE':
    case 'DEALLOCATE':
    case 'PICK':
      return 'inventory_pick'
    case 'ADJUST_IN':
    case 'ADJUST_OUT':
    case 'FREEZE':
    case 'UNFREEZE':
    case 'DAMAGE':
    case 'WRITE_OFF':
    case 'REVERSAL':
      return 'inventory_adjust'
    case 'MOVE':
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return 'inventory_transfer'
    default:
      return 'inventory_adjust'
  }
}
