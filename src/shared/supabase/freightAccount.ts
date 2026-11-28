// Client cho mô hình danh tính THEO TÀI KHOẢN của lớp trung gian giao
// tiếp. Bọc RPC freight_acct_* + CRUD qua RLS của migration gộp bản
// sạch 20261128020000_freight_account_model_fresh.sql (quy trình phát
// triển: reset_freight.sql -> chạy lại migration fresh, không di trú).
// File freight.ts chỉ còn phần nền dùng chung (mã lỗi, kiểu tải/chuyến,
// đọc groups/orders_view tối thiểu) — UI chỉ dùng file này cho nghiệp vụ.
import { supabase } from './client'
import { FreightError, freightErrText, type Booking, type BookingEvent, type FreightLoad } from './freight'
import type { AccountLinkStatus } from '../../domain/freight/account'
import type { BidStatus } from '../../domain/freight/bid'
import type { BookingStatus } from '../../domain/freight/booking'
import type { LoadStatus, LoadVisibility } from '../../domain/freight/load'

const sb = () => {
  if (!supabase) throw new FreightError('unconfigured', 'Chưa cấu hình Supabase (thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).')
  return supabase
}

const ACCT_ERRORS: Record<string, string> = {
  invalid_role: 'Cần chọn ít nhất một vai trò: chủ kho hoặc vận tải.',
  not_poster: 'Bạn không phải chủ của tải này.',
  not_carrier: 'Tài khoản này chưa đăng ký vai trò vận tải.',
  account_not_found: 'Không tìm thấy tài khoản đó (tài khoản chưa đăng ký hồ sơ trên hệ thống).',
  already_linked: 'Hai tài khoản đã kết nối với nhau rồi.',
  link_not_found: 'Không tìm thấy kết nối này.',
  cannot_link_self: 'Không thể kết nối với chính tài khoản của mình.',
  // T2 — chào giá:
  own_load: 'Không tự đặt chào giá cho tải của chính mình được — tự vận chuyển hãy dùng Chỉ định và chọn chính tài khoản của bạn.',
  bidding_closed: 'Tải này không mở chào giá.',
  not_visible: 'Bạn không thấy được tải này nên không đặt chào giá được.',
  bid_not_found: 'Không tìm thấy chào giá này.',
  bid_expired: 'Chào giá đã hết hạn hiệu lực.',
  not_bid_owner: 'Chào giá này không phải của bạn.',
  invalid_price: 'Giá chào phải lớn hơn 0.',
  invalid_expiry: 'Hạn hiệu lực chào giá phải ở tương lai.',
}

/** Map lỗi RPC sang tiếng Việt: mã riêng của mô hình tài khoản trước, còn lại dùng map dùng chung. */
export function freightAcctErrText(e: unknown): string {
  const m = String((e as { message?: string } | null)?.message ?? '')
  for (const [k, v] of Object.entries(ACCT_ERRORS)) if (m.includes(k)) return v
  return freightErrText(e)
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb().rpc(name, args)
  if (error) throw error
  return data as T
}

async function query<T>(fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await fn()
  if (error) throw error
  return data as T
}

// ----- Kiểu dữ liệu (khớp bảng của migration fresh) -----

export interface AccountProfile {
  account_id: string
  display_name: string
  legal_name: string | null
  tax_code: string | null
  contact_name: string | null
  contact_phone: string | null
  address: string | null
  province: string | null
  is_shipper: boolean
  is_carrier: boolean
  business_license_no: string | null
  capability_note: string | null
  self_declared_at: string
  created_at: string
  updated_at: string
}

export interface MyWarehouse {
  id: string
  account_id: string
  name: string
  address: string
  province: string | null
  lat: number | null
  lng: number | null
  open_hours: { open?: string; close?: string } | null
  dock_count: number | null
  arrival_requirements: string | null
  contact_name: string | null
  contact_phone: string | null
  active: boolean
}

export interface MyVehicle {
  id: string
  account_id: string
  plate: string
  vehicle_type: string
  payload_kg: number | null
  box_length_m: number | null
  box_width_m: number | null
  box_height_m: number | null
  inspection_expires_at: string | null
  insurance_expires_at: string | null
  active: boolean
}

export interface MyDriver {
  id: string
  account_id: string
  user_id: string | null
  full_name: string
  phone: string | null
  license_class: string | null
  license_expires_at: string | null
  active: boolean
}

export interface MyRoute {
  id: string
  account_id: string
  from_province: string
  to_province: string
  vehicle_type: string | null
  ref_price: number | null
  note: string | null
  active: boolean
}

export interface AccountLink {
  id: string
  requester_account_id: string
  addressee_account_id: string
  source: 'MANUAL' | 'PAST_DEAL'
  status: AccountLinkStatus
  created_by: string | null
  created_at: string
}

/** Tải theo mô hình tài khoản (bảng freight_loads, mô hình tài khoản). */
export type AcctLoad = FreightLoad & {
  poster_account_id: string | null
  directed_account_id: string | null
  pickup_point_id: string | null
}

/** Dòng rút gọn từ view freight_loads_discover. */
export interface DiscoverLoad {
  id: string
  code: string
  poster_account_id: string | null
  poster_display_name: string | null
  goods_desc: string
  weight_kg: number | null
  packages: number | null
  volume_m3: number | null
  vehicle_type_required: string | null
  pickup_province: string | null
  delivery_province: string | null
  pickup_window_from: string | null
  pickup_window_to: string | null
  delivery_window_to: string | null
  visibility: LoadVisibility
  asking_price: number | null
  /** T2: tải có đang mở chào giá không. */
  open_for_bids: boolean
  status: LoadStatus
  expires_at: string | null
  created_at: string
}

/** Chuyến theo mô hình tài khoản (bảng freight_bookings, mô hình tài khoản). */
export type AcctBooking = Booking & {
  shipper_account_id: string | null
  carrier_account_id: string | null
  my_vehicle_id: string | null
  my_driver_id: string | null
  /** T2: bid nguồn nếu chuyến sinh ra từ chào giá (null nếu chỉ định trực tiếp). */
  bid_id: string | null
}

export type { BookingEvent }

// ----- Hồ sơ tài khoản của tôi -----

export async function getMyAccountProfile(me: string): Promise<AccountProfile | null> {
  const rows = await query<AccountProfile[]>(() => sb().from('freight_account_profiles').select('*').eq('account_id', me))
  return rows[0] ?? null
}

export interface AccountProfileUpsert {
  displayName: string
  legalName?: string | null
  taxCode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  address?: string | null
  province?: string | null
  isShipper: boolean
  isCarrier: boolean
  businessLicenseNo?: string | null
  capabilityNote?: string | null
}

export async function upsertMyAccountProfile(i: AccountProfileUpsert): Promise<AccountProfile> {
  return rpc<AccountProfile>('freight_acct_upsert_profile', {
    p_display_name: i.displayName,
    p_legal_name: i.legalName ?? null,
    p_tax_code: i.taxCode ?? null,
    p_contact_name: i.contactName ?? null,
    p_contact_phone: i.contactPhone ?? null,
    p_address: i.address ?? null,
    p_province: i.province ?? null,
    p_is_shipper: i.isShipper,
    p_is_carrier: i.isCarrier,
    p_business_license_no: i.businessLicenseNo ?? null,
    p_capability_note: i.capabilityNote ?? null,
  })
}

/**
 * Danh bạ tài khoản: mọi hồ sơ đã đăng ký (RLS cho mọi tài khoản đã
 * đăng nhập đọc — thông tin tự khai để hai bên liên lạc). Lọc phía
 * client theo tên/SĐT; onlyCarriers = chỉ tài khoản có vai trò vận tải.
 */
export async function listAccountDirectory(opts: { onlyCarriers?: boolean; search?: string } = {}): Promise<AccountProfile[]> {
  let rows = await query<AccountProfile[]>(() =>
    sb().from('freight_account_profiles').select('*').order('display_name', { ascending: true }).limit(500),
  )
  if (opts.onlyCarriers) rows = rows.filter((r) => r.is_carrier)
  const q = opts.search?.trim().toLowerCase()
  if (q) {
    rows = rows.filter(
      (r) =>
        r.display_name.toLowerCase().includes(q) ||
        (r.contact_phone ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        (r.province ?? '').toLowerCase().includes(q),
    )
  }
  return rows
}

// ----- CRUD của tôi qua RLS: kho / xe / tài xế / tuyến -----

export async function listMyWarehouses(me: string): Promise<MyWarehouse[]> {
  return query<MyWarehouse[]>(() =>
    sb().from('freight_my_warehouses').select('*').eq('account_id', me).order('name', { ascending: true }),
  )
}

export type MyWarehouseInput = Omit<MyWarehouse, 'id' | 'account_id' | 'active'> & { active?: boolean }

export async function saveMyWarehouse(me: string, id: string | null, i: MyWarehouseInput): Promise<void> {
  const row = { account_id: me, ...i }
  const { error } = id ? await sb().from('freight_my_warehouses').update(row).eq('id', id) : await sb().from('freight_my_warehouses').insert(row)
  if (error) throw error
}

export async function setMyWarehouseActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_my_warehouses').update({ active }).eq('id', id)
  if (error) throw error
}

export async function deleteMyWarehouse(id: string): Promise<void> {
  const { error } = await sb().from('freight_my_warehouses').delete().eq('id', id)
  if (error) throw error
}

export async function listMyVehicles(me: string): Promise<MyVehicle[]> {
  return query<MyVehicle[]>(() => sb().from('freight_my_vehicles').select('*').eq('account_id', me).order('plate', { ascending: true }))
}

export type MyVehicleInput = Omit<MyVehicle, 'id' | 'account_id' | 'active'> & { active?: boolean }

export async function saveMyVehicle(me: string, id: string | null, i: MyVehicleInput): Promise<void> {
  const row = { account_id: me, ...i }
  const { error } = id ? await sb().from('freight_my_vehicles').update(row).eq('id', id) : await sb().from('freight_my_vehicles').insert(row)
  if (error) throw error
}

export async function setMyVehicleActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_my_vehicles').update({ active }).eq('id', id)
  if (error) throw error
}

export async function deleteMyVehicle(id: string): Promise<void> {
  const { error } = await sb().from('freight_my_vehicles').delete().eq('id', id)
  if (error) throw error
}

export async function listMyDrivers(me: string): Promise<MyDriver[]> {
  return query<MyDriver[]>(() => sb().from('freight_my_drivers').select('*').eq('account_id', me).order('full_name', { ascending: true }))
}

export type MyDriverInput = Omit<MyDriver, 'id' | 'account_id' | 'active'> & { active?: boolean }

export async function saveMyDriver(me: string, id: string | null, i: MyDriverInput): Promise<void> {
  const row = { account_id: me, ...i }
  const { error } = id ? await sb().from('freight_my_drivers').update(row).eq('id', id) : await sb().from('freight_my_drivers').insert(row)
  if (error) throw error
}

export async function setMyDriverActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_my_drivers').update({ active }).eq('id', id)
  if (error) throw error
}

export async function deleteMyDriver(id: string): Promise<void> {
  const { error } = await sb().from('freight_my_drivers').delete().eq('id', id)
  if (error) throw error
}

export async function listMyRoutes(me: string): Promise<MyRoute[]> {
  return query<MyRoute[]>(() => sb().from('freight_my_routes').select('*').eq('account_id', me).order('created_at', { ascending: true }))
}

export type MyRouteInput = Omit<MyRoute, 'id' | 'account_id' | 'active'> & { active?: boolean }

export async function saveMyRoute(me: string, id: string | null, i: MyRouteInput): Promise<void> {
  const row = { account_id: me, ...i }
  const { error } = id ? await sb().from('freight_my_routes').update(row).eq('id', id) : await sb().from('freight_my_routes').insert(row)
  if (error) throw error
}

export async function setMyRouteActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_my_routes').update({ active }).eq('id', id)
  if (error) throw error
}

export async function deleteMyRoute(id: string): Promise<void> {
  const { error } = await sb().from('freight_my_routes').delete().eq('id', id)
  if (error) throw error
}

/** Các nhà xe (account_id) mà tài khoản này là TÀI XẾ liên kết đang active. */
export async function listMyDriverCarrierIds(me: string): Promise<string[]> {
  const rows = await query<{ account_id: string }[]>(() =>
    sb().from('freight_my_drivers').select('account_id').eq('user_id', me).eq('active', true),
  )
  return [...new Set(rows.map((r) => r.account_id))]
}

// ----- Kết nối giữa hai tài khoản -----

export async function listMyAccountLinks(me: string): Promise<AccountLink[]> {
  return query<AccountLink[]>(() =>
    sb()
      .from('freight_account_links')
      .select('*')
      .or(`requester_account_id.eq.${me},addressee_account_id.eq.${me}`)
      .order('created_at', { ascending: false }),
  )
}

export async function inviteAccountLink(otherAccountId: string): Promise<AccountLink> {
  return rpc<AccountLink>('freight_acct_invite_link', { p_other_account_id: otherAccountId })
}

/** accept=true: chấp nhận (phía nhận) / accept=false: từ chối, rút mời hoặc kết thúc. Trả null khi dòng đã bị xoá. */
export async function respondAccountLink(linkId: string, accept: boolean): Promise<AccountLink | null> {
  return rpc<AccountLink | null>('freight_acct_respond_link', { p_link_id: linkId, p_accept: accept })
}

// ----- Tải theo tài khoản -----

export interface CreateAcctLoadInput {
  sourceGroupId?: string | null
  orderId?: string | null
  shipmentCode?: string | null
  goodsDesc: string
  weightKg?: number | null
  packages?: number | null
  volumeM3?: number | null
  vehicleTypeRequired?: string | null
  pickupPointId?: string | null
  pickupAddress?: string | null
  pickupProvince?: string | null
  deliveryAddress?: string | null
  deliveryProvince?: string | null
  deliveryContactName?: string | null
  deliveryContactPhone?: string | null
  pickupWindowFrom?: string | null
  pickupWindowTo?: string | null
  deliveryWindowTo?: string | null
  visibility: LoadVisibility
  directedAccountId?: string | null
  askingPrice?: number | null
  expiresAt?: string | null
  /** T2: mở chào giá? null/bỏ trống = mặc định theo mức hiển thị (DIRECT tắt, NETWORK/PUBLIC mở). */
  openForBids?: boolean | null
}

export async function createLoadAcct(i: CreateAcctLoadInput): Promise<AcctLoad> {
  return rpc<AcctLoad>('freight_acct_create_load', {
    p_source_group_id: i.sourceGroupId ?? null,
    p_order_id: i.orderId ?? null,
    p_shipment_code: i.shipmentCode ?? null,
    p_goods_desc: i.goodsDesc,
    p_weight_kg: i.weightKg ?? null,
    p_packages: i.packages ?? null,
    p_volume_m3: i.volumeM3 ?? null,
    p_vehicle_type_required: i.vehicleTypeRequired ?? null,
    p_pickup_point_id: i.pickupPointId ?? null,
    p_pickup_address: i.pickupAddress ?? null,
    p_pickup_province: i.pickupProvince ?? null,
    p_delivery_address: i.deliveryAddress ?? null,
    p_delivery_province: i.deliveryProvince ?? null,
    p_delivery_contact_name: i.deliveryContactName ?? null,
    p_delivery_contact_phone: i.deliveryContactPhone ?? null,
    p_pickup_window_from: i.pickupWindowFrom ?? null,
    p_pickup_window_to: i.pickupWindowTo ?? null,
    p_delivery_window_to: i.deliveryWindowTo ?? null,
    p_visibility: i.visibility,
    p_directed_account_id: i.directedAccountId ?? null,
    p_asking_price: i.askingPrice ?? null,
    p_expires_at: i.expiresAt ?? null,
    p_open_for_bids: i.openForBids ?? null,
  })
}

export async function listMyAcctLoads(me: string): Promise<AcctLoad[]> {
  return query<AcctLoad[]>(() =>
    sb().from('freight_loads').select('*').eq('poster_account_id', me).order('created_at', { ascending: false }).limit(200),
  )
}

/** Tải đang mở mà tài khoản của tôi thấy được (view rút gọn theo tài khoản). */
export async function listDiscoverLoads(): Promise<DiscoverLoad[]> {
  return query<DiscoverLoad[]>(() => sb().from('freight_loads_discover').select('*').order('created_at', { ascending: false }).limit(200))
}

export async function cancelLoadAcct(loadId: string, reason: string | null): Promise<AcctLoad> {
  return rpc<AcctLoad>('freight_acct_cancel_load', { p_load_id: loadId, p_reason: reason })
}

export interface LoadShare {
  id: string
  load_id: string
  group_id: string
  shared_by: string
}

export async function listLoadShares(loadId: string): Promise<LoadShare[]> {
  return query<LoadShare[]>(() => sb().from('freight_load_groups').select('*').eq('load_id', loadId))
}

export async function shareLoadToGroup(loadId: string, groupId: string): Promise<void> {
  await rpc('freight_acct_share_load_to_group', { p_load_id: loadId, p_group_id: groupId })
}

export async function unshareLoad(loadId: string, groupId: string): Promise<void> {
  await rpc('freight_acct_unshare_load', { p_load_id: loadId, p_group_id: groupId })
}

// ----- Chuyến theo tài khoản -----

export async function listBookingsAsShipperAcct(me: string): Promise<AcctBooking[]> {
  return query<AcctBooking[]>(() =>
    sb().from('freight_bookings').select('*').eq('shipper_account_id', me).order('created_at', { ascending: false }).limit(200),
  )
}

export async function listBookingsAsCarrierAcct(me: string): Promise<AcctBooking[]> {
  return query<AcctBooking[]>(() =>
    sb().from('freight_bookings').select('*').eq('carrier_account_id', me).order('created_at', { ascending: false }).limit(200),
  )
}

/** Chuyến mà tôi là TÀI XẾ liên kết (nhà xe của chuyến nằm trong danh sách tôi lái cho). */
export async function listBookingsAsDriverAcct(carrierAccountIds: string[]): Promise<AcctBooking[]> {
  if (carrierAccountIds.length === 0) return []
  return query<AcctBooking[]>(() =>
    sb()
      .from('freight_bookings')
      .select('*')
      .in('carrier_account_id', carrierAccountIds)
      .order('created_at', { ascending: false })
      .limit(200),
  )
}

export async function assignBookingAcct(loadId: string, carrierAccountId: string, priceAgreed: number | null): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_assign_booking', {
    p_load_id: loadId,
    p_carrier_account_id: carrierAccountId,
    p_price_agreed: priceAgreed,
  })
}

export async function respondBookingAcct(bookingId: string, accept: boolean, note: string | null): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_respond_booking', { p_booking_id: bookingId, p_accept: accept, p_note: note })
}

export async function assignMyVehicleDriver(bookingId: string, myVehicleId: string | null, myDriverId: string | null): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_assign_vehicle_driver', {
    p_booking_id: bookingId,
    p_my_vehicle_id: myVehicleId,
    p_my_driver_id: myDriverId,
  })
}

export async function advanceBookingAcct(
  bookingId: string,
  toStatus: BookingStatus,
  note: string | null,
  lat?: number | null,
  lng?: number | null,
): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_advance_booking', {
    p_booking_id: bookingId,
    p_to_status: toStatus,
    p_note: note,
    p_lat: lat ?? null,
    p_lng: lng ?? null,
  })
}

export async function cancelBookingAcct(bookingId: string, reason: string): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_cancel_booking', { p_booking_id: bookingId, p_reason: reason })
}

// ----- T2: Chào giá (freight_bids) -----

/** Một chào giá (bảng freight_bids). Tên cột theo thiết kế Phần 3.1. */
export interface FreightBid {
  id: string
  load_id: string
  carrier_account_id: string
  bid_price: number
  currency: string
  proposed_vehicle_id: string | null
  proposed_driver_id: string | null
  eta_pickup_at: string | null
  note: string | null
  status: BidStatus
  closed_reason: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export interface BidHistoryRow {
  id: number
  bid_id: string
  old_price: number | null
  new_price: number | null
  old_eta_pickup_at: string | null
  new_eta_pickup_at: string | null
  changed_by: string
  created_at: string
}

export interface PlaceBidInput {
  loadId: string
  bidPrice: number
  proposedVehicleId?: string | null
  proposedDriverId?: string | null
  etaPickupAt?: string | null
  note?: string | null
  expiresAt?: string | null
}

/**
 * Đặt chào giá. Nếu đã có bid PENDING của chính mình cho tải này, RPC
 * CẬP NHẬT bid đó (sửa giá tại chỗ + ghi lịch sử) và trả về bid đã cập
 * nhật — không bao giờ tạo bid hiệu lực thứ hai.
 */
export async function placeBid(i: PlaceBidInput): Promise<FreightBid> {
  return rpc<FreightBid>('freight_acct_place_bid', {
    p_load_id: i.loadId,
    p_bid_price: i.bidPrice,
    p_proposed_vehicle_id: i.proposedVehicleId ?? null,
    p_proposed_driver_id: i.proposedDriverId ?? null,
    p_eta_pickup_at: i.etaPickupAt ?? null,
    p_note: i.note ?? null,
    p_expires_at: i.expiresAt ?? null,
  })
}

/** Sửa bid của chính mình (chỉ khi PENDING, chưa hết hạn). */
export async function updateBid(bidId: string, i: Omit<PlaceBidInput, 'loadId'>): Promise<FreightBid> {
  return rpc<FreightBid>('freight_acct_update_bid', {
    p_bid_id: bidId,
    p_bid_price: i.bidPrice,
    p_proposed_vehicle_id: i.proposedVehicleId ?? null,
    p_proposed_driver_id: i.proposedDriverId ?? null,
    p_eta_pickup_at: i.etaPickupAt ?? null,
    p_note: i.note ?? null,
    p_expires_at: i.expiresAt ?? null,
  })
}

/** Rút chào giá của chính mình. */
export async function withdrawBid(bidId: string): Promise<FreightBid> {
  return rpc<FreightBid>('freight_acct_withdraw_bid', { p_bid_id: bidId })
}

/** Chủ tải từ chối một bid (lý do tuỳ chọn — chỉ để nhà xe biết). */
export async function rejectBid(bidId: string, reason: string | null): Promise<FreightBid> {
  return rpc<FreightBid>('freight_acct_reject_bid', { p_bid_id: bidId, p_reason: reason })
}

/**
 * Chủ tải chấp nhận một bid — nguyên tử phía server: tạo booking ở
 * trạng thái BOOKED (giá đóng băng = giá bid, xe/tài xế dự kiến gán
 * sẵn), đóng mọi bid còn lại của tải. Trả về booking vừa tạo.
 */
export async function acceptBid(bidId: string): Promise<AcctBooking> {
  return rpc<AcctBooking>('freight_acct_accept_bid', { p_bid_id: bidId })
}

/** Mọi bid của MỘT tải mà phía gọi được quyền thấy (chủ tải: tất cả; nhà xe: của mình). */
export async function listBidsForLoad(loadId: string): Promise<FreightBid[]> {
  return query<FreightBid[]>(() =>
    sb().from('freight_bids').select('*').eq('load_id', loadId).order('bid_price', { ascending: true }),
  )
}

/**
 * Mọi bid mà tài khoản của tôi THẤY ĐƯỢC qua RLS: bid của chính tôi
 * (phía nhà xe) + bid trên các tải của tôi (phía chủ tải) + bid thắng
 * của các chuyến tôi là một phía. UI tự lọc theo nhu cầu.
 */
export async function listVisibleBids(): Promise<FreightBid[]> {
  return query<FreightBid[]>(() =>
    sb().from('freight_bids').select('*').order('created_at', { ascending: false }).limit(500),
  )
}

/** Các bid của chính tôi ở phía nhà xe, mới nhất trước. */
export async function listMyBids(me: string): Promise<FreightBid[]> {
  return query<FreightBid[]>(() =>
    sb().from('freight_bids').select('*').eq('carrier_account_id', me).order('created_at', { ascending: false }).limit(200),
  )
}

/** Lịch sử sửa giá/ETA của một bid (hai phía của bid đều đọc được). */
export async function listBidHistory(bidId: string): Promise<BidHistoryRow[]> {
  return query<BidHistoryRow[]>(() =>
    sb().from('freight_bid_history').select('*').eq('bid_id', bidId).order('id', { ascending: true }),
  )
}

/**
 * Quét hết hạn cơ hội (đóng bid/tải quá hạn phía server). Gọi khi mở
 * tab Tìm xe; lỗi bị bỏ qua ở nơi gọi — dữ liệu vẫn đúng nhờ đóng lười
 * trong từng RPC.
 */
export async function expireStale(): Promise<number> {
  return rpc<number>('freight_acct_expire_stale', {})
}

/** Đọc xe theo danh sách id (RLS tự lọc: của tôi + xe được đề xuất trong bid cho tải của tôi). */
export async function listVehiclesByIds(ids: string[]): Promise<MyVehicle[]> {
  if (ids.length === 0) return []
  return query<MyVehicle[]>(() => sb().from('freight_my_vehicles').select('*').in('id', ids))
}

/** Đọc tài xế theo danh sách id (RLS tự lọc như xe). */
export async function listDriversByIds(ids: string[]): Promise<MyDriver[]> {
  if (ids.length === 0) return []
  return query<MyDriver[]>(() => sb().from('freight_my_drivers').select('*').in('id', ids))
}
