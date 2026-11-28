// R1 — mô hình danh tính theo TÀI KHOẢN: validate hồ sơ hai vai, xác
// định phía theo tài khoản, kết nối hai tài khoản, quy tắc hiển thị tải
// theo tài khoản. Logic thuần ở src/domain/freight/account.ts.
// Máy trạng thái Load/Booking KHÔNG đổi ở R1 — test cũ ở freight.test.ts
// phải pass nguyên vẹn (chạy cùng bộ test).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountActorSide,
  canSeeLoad,
  isAccountLinked,
  isSelfHaul,
  linkRelationWith,
  linkedAccountIds,
  validateAccountProfile,
  validateWarehouse,
  type AccountLinkLike,
} from '../src/domain/freight/account.ts'
import { validateDriver, validateVehicle } from '../src/domain/freight/profile.ts'

const ME = 'acct-me'
const SHIPPER = 'acct-shipper'
const CARRIER = 'acct-carrier'
const OTHER = 'acct-other'

describe('Validate hồ sơ tài khoản hai vai', () => {
  it('một vai trò là đủ; CẢ HAI vai cùng bật cũng hợp lệ (chủ kho kiêm vận tải)', () => {
    assert.deepEqual(validateAccountProfile({ display_name: 'Kho A', is_shipper: true, is_carrier: false }), [])
    assert.deepEqual(validateAccountProfile({ display_name: 'Xe B', is_shipper: false, is_carrier: true }), [])
    assert.deepEqual(
      validateAccountProfile({
        display_name: 'Công ty C',
        is_shipper: true,
        is_carrier: true,
        tax_code: '0312345678',
        contact_phone: '0901234567',
        business_license_no: 'GP-123',
      }),
      [],
    )
  })

  it('chưa chọn vai trò nào thì lỗi; tên hiển thị rỗng thì lỗi', () => {
    const errs = validateAccountProfile({ display_name: 'X', is_shipper: false, is_carrier: false })
    assert.ok(errs.some((e) => e.includes('vai trò')))
    assert.ok(validateAccountProfile({ display_name: '  ', is_shipper: true, is_carrier: false }).length > 0)
  })

  it('định dạng MST/SĐT sai thì lỗi; không khai thì không lỗi', () => {
    assert.ok(
      validateAccountProfile({ display_name: 'X', is_shipper: true, is_carrier: false, tax_code: 'abc' }).some((e) =>
        e.includes('Mã số thuế'),
      ),
    )
    assert.ok(
      validateAccountProfile({ display_name: 'X', is_shipper: true, is_carrier: false, contact_phone: 'xyz' }).some((e) =>
        e.includes('điện thoại'),
      ),
    )
    assert.deepEqual(validateAccountProfile({ display_name: 'X', is_shipper: true, is_carrier: false, tax_code: '', contact_phone: '' }), [])
  })

  it('kho: tên + địa chỉ bắt buộc, còn lại mềm', () => {
    assert.deepEqual(validateWarehouse({ name: 'Kho 1', address: 'Số 1, Q.1' }), [])
    assert.ok(validateWarehouse({ name: '', address: 'X' }).length > 0)
    assert.ok(validateWarehouse({ name: 'K', address: ' ' }).length > 0)
    assert.ok(validateWarehouse({ name: 'K', address: 'X', dock_count: -1 }).length > 0)
  })

  it('giữ tính chất Bản A: giấy tờ hết hạn ở quá khứ vẫn hợp lệ (dùng lại validate T1)', () => {
    assert.deepEqual(
      validateVehicle({ plate: '51C-1', vehicle_type: 'Tải', inspection_expires_at: '2018-01-01', insurance_expires_at: '2018-01-01' }),
      [],
    )
    assert.deepEqual(validateDriver({ full_name: 'A', license_expires_at: '2019-05-05' }), [])
  })
})

describe('accountActorSide — phía theo tài khoản', () => {
  it('chủ tải / nhà xe / người ngoài', () => {
    assert.equal(accountActorSide(SHIPPER, SHIPPER, CARRIER), 'SHIPPER')
    assert.equal(accountActorSide(CARRIER, SHIPPER, CARRIER), 'CARRIER')
    assert.equal(accountActorSide(OTHER, SHIPPER, CARRIER), null)
    assert.equal(accountActorSide(ME, null, null), null)
  })

  it('tài xế liên kết: tài khoản tài xế hành động phía DRIVER cho chuyến của nhà xe mình', () => {
    const driverAcct = 'acct-driver'
    // driverCarrierAccountIds = các nhà xe mà tài khoản này là tài xế active.
    assert.equal(accountActorSide(driverAcct, SHIPPER, CARRIER, [CARRIER]), 'DRIVER')
    // Không liên kết với nhà xe của chuyến này thì là người ngoài.
    assert.equal(accountActorSide(driverAcct, SHIPPER, CARRIER, [OTHER]), null)
    assert.equal(accountActorSide(driverAcct, SHIPPER, CARRIER), null)
  })

  it('tự vận chuyển: shipper = carrier = me -> SHIPPER (ưu tiên), isSelfHaul đúng', () => {
    assert.equal(accountActorSide(ME, ME, ME), 'SHIPPER')
    assert.equal(isSelfHaul(ME, ME, ME), true)
    assert.equal(isSelfHaul(ME, ME, CARRIER), false)
    assert.equal(isSelfHaul(ME, SHIPPER, ME), false)
  })

  it('ưu tiên SHIPPER khi tài khoản vừa là chủ hàng vừa là tài xế của nhà xe đối tác', () => {
    // Tôi là chủ hàng của chuyến, đồng thời là tài xế liên kết của nhà xe kia:
    // phía chủ hàng thắng (khớp thứ tự freight_acct_actor_side).
    assert.equal(accountActorSide(ME, ME, CARRIER, [CARRIER]), 'SHIPPER')
  })
})

describe('Kết nối hai tài khoản', () => {
  const links: AccountLinkLike[] = [
    { requester_account_id: ME, addressee_account_id: CARRIER, status: 'ACCEPTED' },
    { requester_account_id: OTHER, addressee_account_id: ME, status: 'PENDING' },
    { requester_account_id: ME, addressee_account_id: SHIPPER, status: 'ENDED' },
  ]

  it('isAccountLinked chỉ đúng với ACCEPTED, bất kể chiều mời', () => {
    assert.equal(isAccountLinked(links, ME, CARRIER), true)
    assert.equal(isAccountLinked(links, CARRIER, ME), true)
    assert.equal(isAccountLinked(links, ME, OTHER), false) // mới PENDING
    assert.equal(isAccountLinked(links, ME, SHIPPER), false) // đã ENDED
  })

  it('linkRelationWith phân biệt lời mời đi / đến', () => {
    assert.equal(linkRelationWith(links, ME, CARRIER), 'ACCEPTED')
    assert.equal(linkRelationWith(links, ME, OTHER), 'PENDING_IN')
    assert.equal(linkRelationWith(links, OTHER, ME), 'PENDING_OUT')
    assert.equal(linkRelationWith(links, ME, SHIPPER), 'ENDED')
    assert.equal(linkRelationWith(links, ME, 'acct-nobody'), null)
  })

  it('linkedAccountIds chỉ gồm các tài khoản ACCEPTED với mình', () => {
    assert.deepEqual(linkedAccountIds(links, ME), [CARRIER])
    assert.deepEqual(linkedAccountIds(links, CARRIER), [ME])
  })
})

describe('canSeeLoad — hiển thị theo tài khoản', () => {
  const base = { me: CARRIER, posterAccountId: SHIPPER, linkedIds: [] as string[], sameGroupAccountIds: [] as string[] }

  it('PUBLIC: ai đã đăng nhập cũng thấy', () => {
    assert.equal(canSeeLoad({ ...base, visibility: 'PUBLIC' }), true)
  })

  it('DIRECT: chỉ tài khoản được chỉ định', () => {
    assert.equal(canSeeLoad({ ...base, visibility: 'DIRECT', directedAccountId: CARRIER }), true)
    assert.equal(canSeeLoad({ ...base, visibility: 'DIRECT', directedAccountId: OTHER }), false)
    assert.equal(canSeeLoad({ ...base, visibility: 'DIRECT', directedAccountId: null }), false)
  })

  it('NETWORK: đã kết nối ACCEPTED thì thấy', () => {
    assert.equal(canSeeLoad({ ...base, visibility: 'NETWORK', linkedIds: [SHIPPER] }), true)
    assert.equal(canSeeLoad({ ...base, visibility: 'NETWORK', linkedIds: [OTHER] }), false)
  })

  it('NETWORK: cùng group trao đổi với chủ tải cũng thấy (điểm chốt 2b)', () => {
    assert.equal(canSeeLoad({ ...base, visibility: 'NETWORK', sameGroupAccountIds: [SHIPPER] }), true)
    assert.equal(canSeeLoad({ ...base, visibility: 'NETWORK', sameGroupAccountIds: [OTHER] }), false)
  })

  it('chủ tải luôn thấy tải của mình ở mọi mức; tải được chia sẻ vào group của mình thì thấy', () => {
    assert.equal(canSeeLoad({ me: SHIPPER, posterAccountId: SHIPPER, visibility: 'DIRECT', directedAccountId: OTHER, linkedIds: [], sameGroupAccountIds: [] }), true)
    assert.equal(canSeeLoad({ ...base, visibility: 'DIRECT', directedAccountId: OTHER, sharedToMyGroup: true }), true)
    assert.equal(canSeeLoad({ ...base, visibility: 'NETWORK', sharedToMyGroup: true }), true)
  })
})
