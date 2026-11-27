// Bản A (T1) — lớp trung gian giao tiếp Kho <-> Vận tải: máy trạng thái Load/
// Booking, ánh xạ về trạng thái đơn cũ, validate hồ sơ tự khai.
// Logic thuần ở src/domain/freight.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertLoadTransition, canTransitionLoad, isLoadOpen, validateLoadInput,
} from '../src/domain/freight/load.ts'
import {
  assertBookingTransition, bookingActionsFor, canCancelBooking, canTransitionBooking,
  isBookingLive, isBookingTerminal,
} from '../src/domain/freight/booking.ts'
import {
  bookingToOrderStatus, loadToOrderStatus, orderStatusRank, shouldApplyOrderMapping,
} from '../src/domain/freight/mapping.ts'
import {
  isDateOrEmpty, validateDriver, validateOrgProfile, validateServiceRoute, validateVehicle,
} from '../src/domain/freight/profile.ts'

describe('Load transitions', () => {
  it('luồng chính DRAFT->POSTED->ASSIGNED->BOOKED và các nhánh mở lại', () => {
    assert.equal(canTransitionLoad('DRAFT', 'POSTED'), true)
    assert.equal(canTransitionLoad('POSTED', 'ASSIGNED'), true)
    assert.equal(canTransitionLoad('ASSIGNED', 'BOOKED'), true)
    // Nhà xe từ chối chỉ định -> tải mở lại; booking huỷ -> tải mở lại.
    assert.equal(canTransitionLoad('ASSIGNED', 'POSTED'), true)
    assert.equal(canTransitionLoad('BOOKED', 'POSTED'), true)
    // Hết hạn -> đăng lại; huỷ từ các trạng thái chưa chốt.
    assert.equal(canTransitionLoad('POSTED', 'EXPIRED'), true)
    assert.equal(canTransitionLoad('EXPIRED', 'POSTED'), true)
    assert.equal(canTransitionLoad('POSTED', 'CANCELLED'), true)
    assert.equal(canTransitionLoad('DRAFT', 'CANCELLED'), true)
  })

  it('chặn các chuyển đổi không hợp lệ', () => {
    assert.equal(canTransitionLoad('DRAFT', 'BOOKED'), false)
    assert.equal(canTransitionLoad('BOOKED', 'CANCELLED'), false)
    assert.equal(canTransitionLoad('CANCELLED', 'POSTED'), false)
    assert.equal(canTransitionLoad('BOOKED', 'ASSIGNED'), false)
    assert.throws(() => assertLoadTransition('CANCELLED', 'POSTED'), /Không chuyển được tải/)
  })

  it('isLoadOpen chỉ đúng ở POSTED; validate mềm cho tải', () => {
    assert.equal(isLoadOpen('POSTED'), true)
    assert.equal(isLoadOpen('ASSIGNED'), false)
    assert.deepEqual(
      validateLoadInput({ goods_desc: 'Gạo 25kg', weight_kg: 5000, delivery_address: 'Kho B, Cần Thơ', visibility: 'NETWORK' }),
      [],
    )
    assert.ok(validateLoadInput({ goods_desc: ' ', visibility: 'NETWORK', delivery_address: 'X' }).length > 0)
    // DIRECT bắt buộc chọn nhà xe; NETWORK thì không.
    assert.ok(validateLoadInput({ goods_desc: 'Hàng', delivery_address: 'X', visibility: 'DIRECT' }).some((e) => e.includes('Chỉ định')))
    assert.deepEqual(
      validateLoadInput({ goods_desc: 'Hàng', delivery_address: 'X', visibility: 'DIRECT', directed_group_id: 'g-carrier' }),
      [],
    )
    assert.ok(
      validateLoadInput({ goods_desc: 'Hàng', delivery_address: 'X', visibility: 'NETWORK', pickup_window_from: '2026-12-02', pickup_window_to: '2026-12-01' }).length > 0,
    )
  })
})

describe('Booking transitions theo phía', () => {
  it('chỉ định trực tiếp: nhà xe xác nhận/từ chối, chủ hàng huỷ chỉ định', () => {
    assert.equal(canTransitionBooking('PENDING_CONFIRM', 'BOOKED', 'CARRIER'), true)
    assert.equal(canTransitionBooking('PENDING_CONFIRM', 'BOOKED', 'SHIPPER'), false)
    assert.equal(canTransitionBooking('PENDING_CONFIRM', 'DECLINED', 'CARRIER'), true)
    assert.equal(canTransitionBooking('PENDING_CONFIRM', 'DECLINED', 'SHIPPER'), false)
    assert.equal(canTransitionBooking('PENDING_CONFIRM', 'CANCELLED', 'SHIPPER'), true)
  })

  it('mốc chạy chuyến do phía nhà xe/tài xế; chủ hàng không bấm thay', () => {
    assert.equal(canTransitionBooking('BOOKED', 'ARRIVED_PICKUP', 'DRIVER'), true)
    assert.equal(canTransitionBooking('BOOKED', 'ARRIVED_PICKUP', 'SHIPPER'), false)
    assert.equal(canTransitionBooking('ARRIVED_PICKUP', 'PICKED_UP', 'DRIVER'), true)
    // Kho (chủ hàng) cũng xác nhận được mốc lấy hàng — luồng 2.3 bước 9.
    assert.equal(canTransitionBooking('ARRIVED_PICKUP', 'PICKED_UP', 'SHIPPER'), true)
    assert.equal(canTransitionBooking('PICKED_UP', 'IN_TRANSIT', 'CARRIER'), true)
    assert.equal(canTransitionBooking('PICKED_UP', 'IN_TRANSIT', 'SHIPPER'), false)
    assert.equal(canTransitionBooking('IN_TRANSIT', 'ARRIVED_DELIVERY', 'DRIVER'), true)
    assert.equal(canTransitionBooking('ARRIVED_DELIVERY', 'DELIVERED', 'CARRIER'), true)
  })

  it('đóng chuyến do chủ hàng; tranh chấp hai phía gắn được, chủ hàng gỡ bằng xác nhận lại', () => {
    assert.equal(canTransitionBooking('DELIVERED', 'POD_CONFIRMED', 'SHIPPER'), true)
    assert.equal(canTransitionBooking('DELIVERED', 'POD_CONFIRMED', 'CARRIER'), false)
    assert.equal(canTransitionBooking('DELIVERED', 'COMPLETED', 'SHIPPER'), true)
    assert.equal(canTransitionBooking('POD_CONFIRMED', 'COMPLETED', 'SHIPPER'), true)
    assert.equal(canTransitionBooking('DELIVERED', 'DISPUTED', 'CARRIER'), true)
    assert.equal(canTransitionBooking('DISPUTED', 'COMPLETED', 'SHIPPER'), true)
    assert.equal(canTransitionBooking('DISPUTED', 'COMPLETED', 'CARRIER'), false)
  })

  it('huỷ chỉ trước khi lấy hàng; trạng thái kết thúc không đi tiếp', () => {
    assert.equal(canCancelBooking('PENDING_CONFIRM'), true)
    assert.equal(canCancelBooking('BOOKED'), true)
    assert.equal(canCancelBooking('ARRIVED_PICKUP'), true)
    assert.equal(canCancelBooking('PICKED_UP'), false)
    assert.equal(canCancelBooking('IN_TRANSIT'), false)
    assert.equal(canTransitionBooking('BOOKED', 'CANCELLED', 'CARRIER'), true)
    assert.equal(canTransitionBooking('PICKED_UP', 'CANCELLED', 'SHIPPER'), false)
    assert.equal(isBookingTerminal('COMPLETED'), true)
    assert.equal(isBookingLive('COMPLETED'), false)
    assert.equal(isBookingLive('IN_TRANSIT'), true)
    assert.throws(() => assertBookingTransition('COMPLETED', 'BOOKED', 'SHIPPER'), /không chuyển được chuyến/)
  })

  it('bookingActionsFor khớp guard theo phía', () => {
    const carrierActs = bookingActionsFor('PENDING_CONFIRM', 'CARRIER').map((a) => a.to)
    assert.deepEqual(carrierActs.sort(), ['BOOKED', 'DECLINED'])
    const shipperActs = bookingActionsFor('BOOKED', 'SHIPPER').map((a) => a.to)
    assert.deepEqual(shipperActs, ['CANCELLED'])
    const driverActs = bookingActionsFor('BOOKED', 'DRIVER').map((a) => a.to)
    assert.ok(driverActs.includes('ARRIVED_PICKUP') && driverActs.includes('CANCELLED'))
    assert.deepEqual(bookingActionsFor('COMPLETED', 'SHIPPER'), [])
  })
})

describe('Ánh xạ Booking -> trạng thái đơn cũ', () => {
  it('đủ các trạng thái theo bảng 2.6 của Bản A', () => {
    assert.equal(bookingToOrderStatus('BOOKED'), 'CONFIRMED')
    assert.equal(bookingToOrderStatus('PICKED_UP'), 'PICKING')
    assert.equal(bookingToOrderStatus('IN_TRANSIT'), 'IN_TRANSIT')
    assert.equal(bookingToOrderStatus('DELIVERED'), 'DELIVERED')
    assert.equal(bookingToOrderStatus('COMPLETED'), 'COMPLETED')
    // Các trạng thái còn lại không đổi trạng thái đơn.
    for (const s of ['PENDING_CONFIRM', 'ARRIVED_PICKUP', 'ARRIVED_DELIVERY', 'POD_CONFIRMED', 'DISPUTED', 'CANCELLED', 'DECLINED'] as const) {
      assert.equal(bookingToOrderStatus(s), null, s)
    }
    // Load không bao giờ tự đổi trạng thái đơn.
    for (const s of ['DRAFT', 'POSTED', 'ASSIGNED', 'BOOKED', 'EXPIRED', 'CANCELLED'] as const) {
      assert.equal(loadToOrderStatus(s), null, s)
    }
  })

  it('ánh xạ chỉ tiến, không lùi; đơn đã COMPLETED thì không áp nữa', () => {
    assert.equal(orderStatusRank('CREATED'), 0)
    assert.equal(orderStatusRank('COMPLETED'), 5)
    assert.equal(shouldApplyOrderMapping('CREATED', 'BOOKED'), true)
    assert.equal(shouldApplyOrderMapping('CONFIRMED', 'PICKED_UP'), true)
    assert.equal(shouldApplyOrderMapping('IN_TRANSIT', 'PICKED_UP'), false) // đích PICKING đã qua
    assert.equal(shouldApplyOrderMapping('COMPLETED', 'DELIVERED'), false)
    assert.equal(shouldApplyOrderMapping('CREATED', 'ARRIVED_PICKUP'), false) // không có ánh xạ
    assert.equal(shouldApplyOrderMapping('KHONG_RO', 'BOOKED'), false)
  })
})

describe('Validate hồ sơ tự khai — không có rule về hạn giấy tờ', () => {
  it('xe có đăng kiểm/bảo hiểm ĐÃ HẾT HẠN vẫn hợp lệ (chỉ hiển thị, không chặn)', () => {
    const errs = validateVehicle({
      plate: '51C-123.45',
      vehicle_type: 'Xe tải 5 tấn',
      payload_kg: 5000,
      inspection_expires_at: '2020-01-01', // hết hạn từ lâu — vẫn không lỗi
      insurance_expires_at: '2019-06-30',
    })
    assert.deepEqual(errs, [])
  })

  it('tài xế có bằng lái ĐÃ HẾT HẠN vẫn hợp lệ', () => {
    const errs = validateDriver({ full_name: 'Nguyễn Văn A', phone: '0901234567', license_class: 'FC', license_expires_at: '2021-03-15' })
    assert.deepEqual(errs, [])
  })

  it('vẫn chặn rỗng/sai định dạng cơ bản', () => {
    assert.ok(validateVehicle({ plate: ' ', vehicle_type: '' }).length >= 2)
    assert.ok(validateVehicle({ plate: '51C-1', vehicle_type: 'Tải', inspection_expires_at: '31/12/2026' }).some((e) => e.includes('đăng kiểm')))
    assert.ok(validateDriver({ full_name: '' }).length > 0)
    assert.ok(validateDriver({ full_name: 'A', phone: 'abc' }).some((e) => e.includes('điện thoại')))
    assert.ok(validateOrgProfile({ org_type: 'SHIPPER', display_name: ' ' }).length > 0)
    assert.ok(validateOrgProfile({ org_type: 'SHIPPER', display_name: 'Kho A', tax_code: 'abc' }).some((e) => e.includes('Mã số thuế')))
    assert.deepEqual(validateOrgProfile({ org_type: 'CARRIER', display_name: 'Nhà xe B', tax_code: '0312345678' }), [])
    assert.ok(validateServiceRoute({ from_province: '', to_province: 'Cần Thơ' }).length > 0)
    assert.deepEqual(validateServiceRoute({ from_province: 'TP.HCM', to_province: 'Cần Thơ', ref_price: 2500000 }), [])
  })

  it('isDateOrEmpty: rỗng ok, ngày thật ok (kể cả quá khứ), ngày ảo lỗi', () => {
    assert.equal(isDateOrEmpty(null), true)
    assert.equal(isDateOrEmpty(''), true)
    assert.equal(isDateOrEmpty('1999-12-31'), true)
    assert.equal(isDateOrEmpty('2026-02-30'), false)
    assert.equal(isDateOrEmpty('12/31/2026'), false)
  })
})
