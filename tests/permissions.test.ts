import { test } from 'node:test'
import assert from 'node:assert/strict'
import { can, requirePermission, permissionForMovement } from '../src/domain/permissions/guard.ts'
import { LOCAL_ROLES, PERMISSIONS, ROLE_PERMISSIONS } from '../src/domain/permissions/roles.ts'

test('KHO_ADMIN có mọi quyền', () => {
  for (const p of PERMISSIONS) assert.equal(can('KHO_ADMIN', p), true, p)
})

test('KE_TOAN_XEM chỉ xem, không ghi được bất cứ thứ gì', () => {
  assert.equal(can('KE_TOAN_XEM', 'inventory_view'), true)
  assert.equal(can('KE_TOAN_XEM', 'reports_view'), true)
  for (const p of ['inventory_receive', 'inventory_pick', 'inventory_count', 'inventory_adjust',
    'inventory_transfer', 'inventory_putaway', 'purchase_create', 'users_manage', 'devices_manage',
    'backup_manage', 'federation_manage'] as const) {
    assert.equal(can('KE_TOAN_XEM', p), false, p)
  }
})

test('NV_LAY_HANG chỉ pick + xem; không nhận hàng, không điều chỉnh', () => {
  assert.equal(can('NV_LAY_HANG', 'inventory_pick'), true)
  assert.equal(can('NV_LAY_HANG', 'inventory_receive'), false)
  assert.equal(can('NV_LAY_HANG', 'inventory_adjust'), false)
  assert.equal(can('NV_LAY_HANG', 'inventory_count'), false)
})

test('NV_NHAN_HANG nhận + cất được; không pick, không duyệt thiết bị', () => {
  assert.equal(can('NV_NHAN_HANG', 'inventory_receive'), true)
  assert.equal(can('NV_NHAN_HANG', 'inventory_putaway'), true)
  assert.equal(can('NV_NHAN_HANG', 'inventory_pick'), false)
  assert.equal(can('NV_NHAN_HANG', 'devices_manage'), false)
})

test('THU_KHO làm nghiệp vụ kho nhưng không quản user/thiết bị/sao lưu', () => {
  for (const p of ['inventory_receive', 'inventory_pick', 'inventory_count', 'inventory_adjust',
    'inventory_transfer', 'purchase_create'] as const) {
    assert.equal(can('THU_KHO', p), true, p)
  }
  for (const p of ['users_manage', 'devices_manage', 'backup_manage', 'federation_manage'] as const) {
    assert.equal(can('THU_KHO', p), false, p)
  }
})

test('vai trò lạ / rỗng bị từ chối (fail closed); requirePermission ném lỗi', () => {
  assert.equal(can(null, 'inventory_view'), false)
  assert.equal(can(undefined, 'inventory_view'), false)
  assert.equal(can('admin', 'inventory_view'), false) // vai trò Supabase cũ không tự map sang local
  assert.throws(() => requirePermission('KE_TOAN_XEM', 'inventory_adjust'), /Thiếu quyền/)
  requirePermission('THU_KHO', 'inventory_adjust') // không ném
})

test('ma trận nhất quán: mọi vai trò khai đủ, không quyền lạ', () => {
  for (const role of LOCAL_ROLES) {
    const perms = ROLE_PERMISSIONS[role]
    assert.ok(perms.length > 0, role)
    for (const p of perms) assert.ok((PERMISSIONS as readonly string[]).includes(p), `${role}:${p}`)
  }
})

test('permissionForMovement map đúng nhóm nghiệp vụ', () => {
  assert.equal(permissionForMovement('RECEIVE'), 'inventory_receive')
  assert.equal(permissionForMovement('PICK'), 'inventory_pick')
  assert.equal(permissionForMovement('ALLOCATE'), 'inventory_pick')
  assert.equal(permissionForMovement('PUTAWAY'), 'inventory_putaway')
  assert.equal(permissionForMovement('ADJUST_OUT'), 'inventory_adjust')
  assert.equal(permissionForMovement('WRITE_OFF'), 'inventory_adjust')
  assert.equal(permissionForMovement('MOVE'), 'inventory_transfer')
  assert.equal(permissionForMovement('TRANSFER_IN'), 'inventory_transfer')
})
