// T2 (R2) — chào giá: máy trạng thái bid theo phía, validate đặt giá,
// cấm tự đặt bid vào tải của mình, quy tắc open_for_bids theo mức hiển
// thị, bất biến "một bid hiệu lực" ở mức domain, hết hạn lười.
// Logic thuần ở src/domain/freight/bid.ts; guard phía server nằm ở
// RPC freight_acct_place_bid / update_bid / accept_bid trong migration.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  bidEligibility,
  bidTransitionSides,
  canSideTransitionBid,
  canTransitionBid,
  defaultBidExpiry,
  defaultOpenForBids,
  effectiveBidStatus,
  isBidLive,
  isBidStale,
  validateBidInput,
  type BidStatus,
} from '../src/domain/freight/bid.ts'

const ME = 'acct-carrier'
const POSTER = 'acct-shipper'
const NOW = new Date('2026-11-28T10:00:00Z')
const FUTURE = '2026-11-30T10:00:00Z'
const PAST = '2026-11-27T10:00:00Z'

describe('Máy trạng thái bid — chuyển đổi hợp lệ', () => {
  it('PENDING đi được tới cả 4 trạng thái kết thúc', () => {
    for (const to of ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as BidStatus[]) {
      assert.equal(canTransitionBid('PENDING', to), true, `PENDING -> ${to}`)
    }
  })

  it('mọi trạng thái kết thúc đều không chuyển tiếp được nữa', () => {
    for (const from of ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as BidStatus[]) {
      for (const to of ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as BidStatus[]) {
        assert.equal(canTransitionBid(from, to), false, `${from} -> ${to}`)
      }
    }
  })

  it('PENDING không tự quay lại PENDING (sửa giá là cập nhật, không phải chuyển trạng thái)', () => {
    assert.equal(canTransitionBid('PENDING', 'PENDING'), false)
  })
})

describe('Máy trạng thái bid — theo phía', () => {
  it('chỉ chủ tải (SHIPPER) được ACCEPTED / REJECTED', () => {
    assert.deepEqual(bidTransitionSides('PENDING', 'ACCEPTED'), ['SHIPPER'])
    assert.deepEqual(bidTransitionSides('PENDING', 'REJECTED'), ['SHIPPER'])
    assert.equal(canSideTransitionBid('PENDING', 'ACCEPTED', 'SHIPPER'), true)
    assert.equal(canSideTransitionBid('PENDING', 'ACCEPTED', 'CARRIER'), false)
    assert.equal(canSideTransitionBid('PENDING', 'REJECTED', 'CARRIER'), false)
  })

  it('chỉ phía nhà xe (CARRIER) được WITHDRAWN; DRIVER không hành động trên bid', () => {
    assert.deepEqual(bidTransitionSides('PENDING', 'WITHDRAWN'), ['CARRIER'])
    assert.equal(canSideTransitionBid('PENDING', 'WITHDRAWN', 'CARRIER'), true)
    assert.equal(canSideTransitionBid('PENDING', 'WITHDRAWN', 'SHIPPER'), false)
    assert.equal(canSideTransitionBid('PENDING', 'WITHDRAWN', 'DRIVER'), false)
    assert.equal(canSideTransitionBid('PENDING', 'ACCEPTED', 'DRIVER'), false)
  })

  it('chuyển đổi không tồn tại thì không phía nào được làm', () => {
    assert.deepEqual(bidTransitionSides('ACCEPTED', 'PENDING'), [])
    assert.equal(canSideTransitionBid('EXPIRED', 'ACCEPTED', 'SHIPPER'), false)
  })
})

describe('Validate đặt chào giá', () => {
  it('giá > 0 là hợp lệ; xe/tài xế/giờ lấy không bắt buộc', () => {
    assert.deepEqual(validateBidInput({ bid_price: 1500000 }, NOW), [])
    assert.deepEqual(
      validateBidInput(
        { bid_price: 1, expires_at: FUTURE, eta_pickup_at: FUTURE, proposed_vehicle_id: null, proposed_driver_id: null },
        NOW,
      ),
      [],
    )
  })

  it('thiếu giá hoặc giá <= 0 bị chặn', () => {
    assert.ok(validateBidInput({ bid_price: null }, NOW).length > 0)
    assert.ok(validateBidInput({ bid_price: undefined }, NOW).length > 0)
    assert.ok(validateBidInput({ bid_price: 0 }, NOW).some((e) => e.includes('lớn hơn 0')))
    assert.ok(validateBidInput({ bid_price: -5 }, NOW).some((e) => e.includes('lớn hơn 0')))
  })

  it('hạn hiệu lực ở quá khứ bị chặn (hạn của chính đề nghị, không phải giấy tờ)', () => {
    const errs = validateBidInput({ bid_price: 100, expires_at: PAST }, NOW)
    assert.ok(errs.some((e) => e.includes('tương lai')))
    // Đúng tại thời điểm hiện tại cũng không còn hiệu lực.
    assert.ok(validateBidInput({ bid_price: 100, expires_at: NOW.toISOString() }, NOW).length > 0)
  })

  it('hạn hiệu lực để trống là hợp lệ (server áp mặc định 72h)', () => {
    assert.deepEqual(validateBidInput({ bid_price: 100, expires_at: null }, NOW), [])
    assert.deepEqual(validateBidInput({ bid_price: 100, expires_at: '' }, NOW), [])
  })
})

describe('Điều kiện đặt bid — cấm tự đặt bid vào tải của mình', () => {
  const base = {
    me: ME,
    posterAccountId: POSTER,
    isCarrier: true,
    loadStatus: 'POSTED',
    openForBids: true,
    visible: true,
  }

  it('đủ điều kiện thì được đặt', () => {
    assert.deepEqual(bidEligibility(base), { ok: true })
  })

  it('chủ tải tự đặt bid vào tải của mình -> own_load (tự vận chuyển đi đường chỉ định)', () => {
    assert.deepEqual(bidEligibility({ ...base, me: POSTER }), { ok: false, code: 'own_load' })
  })

  it('chưa có vai trò vận tải -> not_carrier', () => {
    assert.deepEqual(bidEligibility({ ...base, isCarrier: false }), { ok: false, code: 'not_carrier' })
  })

  it('tải không còn POSTED -> load_not_open; tải không mở chào giá -> bidding_closed', () => {
    assert.deepEqual(bidEligibility({ ...base, loadStatus: 'BOOKED' }), { ok: false, code: 'load_not_open' })
    assert.deepEqual(bidEligibility({ ...base, openForBids: false }), { ok: false, code: 'bidding_closed' })
  })

  it('không thấy được tải -> not_visible', () => {
    assert.deepEqual(bidEligibility({ ...base, visible: false }), { ok: false, code: 'not_visible' })
  })
})

describe('Quy tắc open_for_bids theo mức hiển thị (thiết kế 3.4)', () => {
  it('DIRECT mặc định TẮT; NETWORK/PUBLIC mặc định MỞ', () => {
    assert.equal(defaultOpenForBids('DIRECT'), false)
    assert.equal(defaultOpenForBids('NETWORK'), true)
    assert.equal(defaultOpenForBids('PUBLIC'), true)
  })
})

describe('Một bid hiệu lực — sửa giá là cập nhật cùng một bid', () => {
  it('đặt lần 2 khi đã có bid PENDING của chính mình không phải chuyển trạng thái và không tạo bid thứ hai', () => {
    // Ở mức domain: bid đang PENDING vẫn "sống", hành động sửa giữ
    // nguyên id + trạng thái; canTransitionBid không có cạnh
    // PENDING->PENDING chính là khẳng định không có vòng đời thứ hai.
    assert.equal(isBidLive('PENDING', FUTURE, NOW), true)
    assert.equal(canTransitionBid('PENDING', 'PENDING'), false)
  })

  it('hạn mặc định là 72 giờ từ hiện tại', () => {
    assert.equal(defaultBidExpiry(NOW).getTime() - NOW.getTime(), 72 * 3600 * 1000)
  })
})

describe('Hết hạn lười (lazy expire) ở mức hiển thị', () => {
  it('bid PENDING quá hạn bị coi là EXPIRED dù server chưa kịp đóng', () => {
    assert.equal(isBidStale('PENDING', PAST, NOW), true)
    assert.equal(isBidLive('PENDING', PAST, NOW), false)
    assert.equal(effectiveBidStatus('PENDING', PAST, NOW), 'EXPIRED')
  })

  it('bid PENDING còn hạn vẫn sống; bid đã đóng không bị stale', () => {
    assert.equal(isBidStale('PENDING', FUTURE, NOW), false)
    assert.equal(effectiveBidStatus('PENDING', FUTURE, NOW), 'PENDING')
    assert.equal(isBidStale('ACCEPTED', PAST, NOW), false)
    assert.equal(effectiveBidStatus('WITHDRAWN', PAST, NOW), 'WITHDRAWN')
  })
})
