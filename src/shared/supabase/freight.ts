// Client cho lớp trung gian giao tiếp Kho <-> Vận tải (Bản A, T1).
// Bọc RPC + truy vấn Supabase của migration 20261127000000_freight_t1_foundation.
// Khi chưa cấu hình Supabase (client null) các hàm ném FreightError mã
// 'unconfigured' để UI hiển thị hướng dẫn thay vì crash.
import { supabase } from './client'
import type { BookingStatus } from '../../domain/freight/booking'
import type { LoadStatus, LoadVisibility } from '../../domain/freight/load'
import type { OrgType } from '../../domain/freight/profile'

export type FreightStatus = 'unconfigured' | 'ready'

export function freightStatus(): FreightStatus {
  return supabase ? 'ready' : 'unconfigured'
}

export class FreightError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

const sb = () => {
  if (!supabase) throw new FreightError('unconfigured', 'Chưa cấu hình Supabase (thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).')
  return supabase
}

const FREIGHT_ERRORS: Record<string, string> = {
  unconfigured: 'Chưa cấu hình Supabase (thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).',
  not_authenticated: 'Cần đăng nhập.',
  not_member: 'Bạn không phải thành viên của nhóm này.',
  not_party: 'Bạn không phải một phía trong chuyến này.',
  forbidden: 'Vai trò của bạn trong nhóm không được làm việc này.',
  invalid_transition: 'Không chuyển trạng thái như vậy được.',
  note_required: 'Thiếu nội dung bắt buộc.',
  reason_required: 'Cần ghi lý do.',
  load_not_found: 'Không tìm thấy tải đăng.',
  load_not_open: 'Tải không còn ở trạng thái đang tìm xe.',
  booking_not_found: 'Không tìm thấy chuyến.',
  carrier_not_found: 'Không tìm thấy hồ sơ nhà xe (nhóm đó chưa khai hồ sơ hoặc không phải phía vận tải).',
  not_carrier_org: 'Nhóm này chưa khai loại tổ chức là phía vận tải.',
  invalid_org_type: 'Loại tổ chức không hợp lệ.',
  invalid_visibility: 'Mức hiển thị không hợp lệ.',
  directed_required: 'Mức "Chỉ định" cần chọn một nhà xe.',
  not_linked: 'Nhà xe này chưa kết nối mạng lưới với nhóm của bạn (cần hai bên xác nhận kết nối trước).',
  order_not_in_group: 'Đơn không thuộc nhóm này.',
  warehouse_not_found: 'Không tìm thấy hồ sơ kho của nhóm.',
  vehicle_not_found: 'Không tìm thấy xe của nhà xe này.',
  driver_not_found: 'Không tìm thấy tài xế của nhà xe này.',
  has_active_booking: 'Tải đang có chuyến đang chạy — hãy huỷ chuyến trước.',
  already_booked: 'Tải này đã có một chuyến đang sống.',
}

/** Map lỗi RPC (mã cấu trúc trong message) sang tiếng Việt; không rõ thì báo chung. */
export function freightErrText(e: unknown): string {
  if (e instanceof FreightError) return FREIGHT_ERRORS[e.code] ?? e.message
  const m = String((e as { message?: string } | null)?.message ?? '')
  for (const [k, v] of Object.entries(FREIGHT_ERRORS)) if (m.includes(k)) return v
  return 'Có lỗi, thử lại sau.'
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

// ----- Kiểu dữ liệu (khớp bảng freight_* trong migration) -----

export interface OrgProfile {
  group_id: string
  org_type: OrgType
  display_name: string
  legal_name: string | null
  tax_code: string | null
  contact_name: string | null
  contact_phone: string | null
  address: string | null
  province: string | null
  self_declared_at: string
  created_at: string
  updated_at: string
}

export interface CarrierProfile {
  group_id: string
  business_license_no: string | null
  capability_note: string | null
}

export interface WarehouseProfile {
  id: string
  group_id: string
  name: string
  address: string
  province: string | null
  lat: number | null
  lng: number | null
  dock_count: number | null
  arrival_requirements: string | null
  contact_name: string | null
  contact_phone: string | null
  active: boolean
}

export interface Vehicle {
  id: string
  group_id: string
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

export interface DriverProfile {
  id: string
  group_id: string
  user_id: string | null
  full_name: string
  phone: string | null
  license_class: string | null
  license_expires_at: string | null
  active: boolean
}

export interface ServiceRoute {
  id: string
  group_id: string
  from_province: string
  to_province: string
  vehicle_type: string | null
  ref_price: number | null
  note: string | null
  active: boolean
}

export interface OrgLink {
  id: string
  shipper_group_id: string
  carrier_group_id: string
  source: 'MANUAL' | 'PAST_DEAL'
  status: 'PENDING' | 'ACCEPTED' | 'ENDED'
  created_by: string | null
  created_at: string
}

export interface FreightLoad {
  id: string
  code: string
  group_id: string
  order_id: string | null
  shipment_code: string | null
  goods_desc: string
  weight_kg: number | null
  packages: number | null
  volume_m3: number | null
  vehicle_type_required: string | null
  pickup_warehouse_id: string | null
  pickup_address: string | null
  pickup_province: string | null
  delivery_address: string | null
  delivery_province: string | null
  delivery_contact_name: string | null
  delivery_contact_phone: string | null
  pickup_window_from: string | null
  pickup_window_to: string | null
  delivery_window_to: string | null
  visibility: LoadVisibility
  directed_group_id: string | null
  asking_price: number | null
  status: LoadStatus
  expires_at: string | null
  created_at: string
}

/** Dòng rút gọn từ view freight_loads_public (trước khi chốt — không có địa chỉ/SĐT chi tiết). */
export interface PublicLoad {
  id: string
  code: string
  shipper_group_id: string
  shipper_display_name: string | null
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
  status: LoadStatus
  expires_at: string | null
  created_at: string
}

export interface Booking {
  id: string
  code: string
  load_id: string
  order_id: string | null
  shipper_group_id: string
  carrier_group_id: string
  vehicle_id: string | null
  driver_id: string | null
  price_agreed: number | null
  status: BookingStatus
  pickup_at_actual: string | null
  delivered_at_actual: string | null
  cancel_reason: string | null
  cancelled_by_side: string | null
  created_at: string
}

export interface BookingEvent {
  id: number
  booking_id: string
  event_type: string
  actor_id: string | null
  actor_side: 'SHIPPER' | 'CARRIER' | 'DRIVER' | 'SYSTEM' | null
  from_status: string | null
  to_status: string | null
  note: string | null
  source: string
  created_at: string
}

export interface GroupLite {
  id: string
  name: string
}

// ----- Nhóm & hồ sơ tổ chức -----

export async function listMyGroups(): Promise<GroupLite[]> {
  return query<GroupLite[]>(() => sb().from('groups').select('id,name').order('created_at', { ascending: true }))
}

/** Vai trò của tôi trong một nhóm (đọc group_members của chính mình). */
export async function myRolesInGroup(groupId: string, userId: string): Promise<string[]> {
  const rows = await query<{ roles: string[] }[]>(() =>
    sb().from('group_members').select('roles').eq('group_id', groupId).eq('user_id', userId),
  )
  return rows[0]?.roles ?? []
}

export async function getOrgProfile(groupId: string): Promise<OrgProfile | null> {
  const rows = await query<OrgProfile[]>(() => sb().from('freight_org_profiles').select('*').eq('group_id', groupId))
  return rows[0] ?? null
}

/** Thư mục tổ chức đã đăng nhập đọc được (để chỉ định nhà xe / kết nối). */
export async function listOrgDirectory(): Promise<OrgProfile[]> {
  return query<OrgProfile[]>(() => sb().from('freight_org_profiles').select('*').order('display_name', { ascending: true }))
}

export interface OrgProfileUpsert {
  groupId: string
  orgType: OrgType
  displayName: string
  legalName?: string | null
  taxCode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  address?: string | null
  province?: string | null
}

export async function upsertOrgProfile(i: OrgProfileUpsert): Promise<OrgProfile> {
  return rpc<OrgProfile>('freight_upsert_org_profile', {
    p_group_id: i.groupId,
    p_org_type: i.orgType,
    p_display_name: i.displayName,
    p_legal_name: i.legalName ?? null,
    p_tax_code: i.taxCode ?? null,
    p_contact_name: i.contactName ?? null,
    p_contact_phone: i.contactPhone ?? null,
    p_address: i.address ?? null,
    p_province: i.province ?? null,
  })
}

export async function getCarrierProfile(groupId: string): Promise<CarrierProfile | null> {
  const rows = await query<CarrierProfile[]>(() => sb().from('freight_carrier_profiles').select('*').eq('group_id', groupId))
  return rows[0] ?? null
}

export async function upsertCarrierProfile(groupId: string, businessLicenseNo: string | null, capabilityNote: string | null): Promise<CarrierProfile> {
  return rpc<CarrierProfile>('freight_upsert_carrier_profile', {
    p_group_id: groupId,
    p_business_license_no: businessLicenseNo,
    p_capability_note: capabilityNote,
  })
}

// ----- CRUD qua RLS: kho / xe / tài xế / tuyến -----

export async function listWarehouses(groupId: string): Promise<WarehouseProfile[]> {
  return query<WarehouseProfile[]>(() =>
    sb().from('freight_warehouse_profiles').select('*').eq('group_id', groupId).order('name', { ascending: true }),
  )
}

export type WarehouseInput = Omit<WarehouseProfile, 'id' | 'group_id' | 'active'> & { active?: boolean }

export async function saveWarehouse(groupId: string, id: string | null, i: WarehouseInput): Promise<void> {
  const row = { group_id: groupId, ...i }
  const { error } = id
    ? await sb().from('freight_warehouse_profiles').update(row).eq('id', id)
    : await sb().from('freight_warehouse_profiles').insert(row)
  if (error) throw error
}

export async function setWarehouseActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_warehouse_profiles').update({ active }).eq('id', id)
  if (error) throw error
}

export async function listVehicles(groupId: string): Promise<Vehicle[]> {
  return query<Vehicle[]>(() => sb().from('freight_vehicles').select('*').eq('group_id', groupId).order('plate', { ascending: true }))
}

export type VehicleInput = Omit<Vehicle, 'id' | 'group_id' | 'active'> & { active?: boolean }

export async function saveVehicle(groupId: string, id: string | null, i: VehicleInput): Promise<void> {
  const row = { group_id: groupId, ...i }
  const { error } = id ? await sb().from('freight_vehicles').update(row).eq('id', id) : await sb().from('freight_vehicles').insert(row)
  if (error) throw error
}

export async function setVehicleActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_vehicles').update({ active }).eq('id', id)
  if (error) throw error
}

export async function listDrivers(groupId: string): Promise<DriverProfile[]> {
  return query<DriverProfile[]>(() => sb().from('freight_drivers').select('*').eq('group_id', groupId).order('full_name', { ascending: true }))
}

export type DriverInput = Omit<DriverProfile, 'id' | 'group_id' | 'active'> & { active?: boolean }

export async function saveDriver(groupId: string, id: string | null, i: DriverInput): Promise<void> {
  const row = { group_id: groupId, ...i }
  const { error } = id ? await sb().from('freight_drivers').update(row).eq('id', id) : await sb().from('freight_drivers').insert(row)
  if (error) throw error
}

export async function setDriverActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_drivers').update({ active }).eq('id', id)
  if (error) throw error
}

export async function listRoutes(groupId: string): Promise<ServiceRoute[]> {
  return query<ServiceRoute[]>(() => sb().from('freight_service_routes').select('*').eq('group_id', groupId).order('created_at', { ascending: true }))
}

export type RouteInput = Omit<ServiceRoute, 'id' | 'group_id' | 'active'> & { active?: boolean }

export async function saveRoute(groupId: string, id: string | null, i: RouteInput): Promise<void> {
  const row = { group_id: groupId, ...i }
  const { error } = id ? await sb().from('freight_service_routes').update(row).eq('id', id) : await sb().from('freight_service_routes').insert(row)
  if (error) throw error
}

export async function setRouteActive(id: string, active: boolean): Promise<void> {
  const { error } = await sb().from('freight_service_routes').update({ active }).eq('id', id)
  if (error) throw error
}

// ----- Kết nối mạng lưới (org_links, qua RLS) -----

export async function listLinksForGroup(groupId: string): Promise<OrgLink[]> {
  return query<OrgLink[]>(() =>
    sb().from('freight_org_links').select('*').or(`shipper_group_id.eq.${groupId},carrier_group_id.eq.${groupId}`).order('created_at', { ascending: false }),
  )
}

export async function inviteLink(shipperGroupId: string, carrierGroupId: string, createdBy: string): Promise<void> {
  const { error } = await sb()
    .from('freight_org_links')
    .insert({ shipper_group_id: shipperGroupId, carrier_group_id: carrierGroupId, source: 'MANUAL', status: 'PENDING', created_by: createdBy })
  if (error) throw error
}

export async function respondLink(linkId: string, accept: boolean): Promise<void> {
  const { error } = await sb()
    .from('freight_org_links')
    .update({ status: accept ? 'ACCEPTED' : 'ENDED' })
    .eq('id', linkId)
  if (error) throw error
}

/** Mời lại một kết nối đã ENDED (cặp nhóm là duy nhất nên cập nhật dòng cũ thay vì tạo mới). */
export async function reinviteLink(linkId: string, createdBy: string): Promise<void> {
  const { error } = await sb()
    .from('freight_org_links')
    .update({ status: 'PENDING', created_by: createdBy })
    .eq('id', linkId)
  if (error) throw error
}

// ----- Tải đăng -----

export interface GroupOrderLite {
  id: string
  code: string
  goods: string
  status: string
  shipment_code: string | null
  pickup_address: string
  delivery_address: string
  weight_kg: number
  packages: number
}

/** Đơn của nhóm để tạo tải từ đơn có sẵn (điểm chạm Bản A mục 3.6). */
export async function listGroupOrders(groupId: string): Promise<GroupOrderLite[]> {
  return query<GroupOrderLite[]>(() =>
    sb()
      .from('orders')
      .select('id,code,goods,status,shipment_code,pickup_address,delivery_address,weight_kg,packages')
      .eq('group_id', groupId)
      .neq('status', 'COMPLETED')
      .order('created_at', { ascending: false })
      .limit(100),
  )
}

export interface CreateLoadInput {
  groupId: string
  orderId?: string | null
  shipmentCode?: string | null
  goodsDesc: string
  weightKg?: number | null
  packages?: number | null
  volumeM3?: number | null
  vehicleTypeRequired?: string | null
  pickupWarehouseId?: string | null
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
  directedGroupId?: string | null
  askingPrice?: number | null
  expiresAt?: string | null
}

export async function createLoad(i: CreateLoadInput): Promise<FreightLoad> {
  return rpc<FreightLoad>('freight_create_load', {
    p_group_id: i.groupId,
    p_order_id: i.orderId ?? null,
    p_shipment_code: i.shipmentCode ?? null,
    p_goods_desc: i.goodsDesc,
    p_weight_kg: i.weightKg ?? null,
    p_packages: i.packages ?? null,
    p_volume_m3: i.volumeM3 ?? null,
    p_vehicle_type_required: i.vehicleTypeRequired ?? null,
    p_pickup_warehouse_id: i.pickupWarehouseId ?? null,
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
    p_directed_group_id: i.directedGroupId ?? null,
    p_asking_price: i.askingPrice ?? null,
    p_expires_at: i.expiresAt ?? null,
  })
}

export async function listMyLoads(groupId: string): Promise<FreightLoad[]> {
  return query<FreightLoad[]>(() =>
    sb().from('freight_loads').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(200),
  )
}

/** Tải đang mở mà nhóm của tôi thấy được (view rút gọn, trước khi chốt). */
export async function listVisibleLoads(): Promise<PublicLoad[]> {
  return query<PublicLoad[]>(() => sb().from('freight_loads_public').select('*').order('created_at', { ascending: false }).limit(200))
}

export async function cancelLoad(loadId: string, reason: string | null): Promise<FreightLoad> {
  return rpc<FreightLoad>('freight_cancel_load', { p_load_id: loadId, p_reason: reason })
}

// ----- Chuyến (booking) -----

export async function listBookingsAsShipper(groupId: string): Promise<Booking[]> {
  return query<Booking[]>(() =>
    sb().from('freight_bookings').select('*').eq('shipper_group_id', groupId).order('created_at', { ascending: false }).limit(200),
  )
}

export async function listBookingsAsCarrier(groupId: string): Promise<Booking[]> {
  return query<Booking[]>(() =>
    sb().from('freight_bookings').select('*').eq('carrier_group_id', groupId).order('created_at', { ascending: false }).limit(200),
  )
}

export async function assignBooking(loadId: string, carrierGroupId: string, priceAgreed: number | null): Promise<Booking> {
  return rpc<Booking>('freight_assign_booking', { p_load_id: loadId, p_carrier_group_id: carrierGroupId, p_price_agreed: priceAgreed })
}

export async function respondBooking(bookingId: string, accept: boolean, note: string | null): Promise<Booking> {
  return rpc<Booking>('freight_respond_booking', { p_booking_id: bookingId, p_accept: accept, p_note: note })
}

export async function assignVehicleDriver(bookingId: string, vehicleId: string | null, driverId: string | null): Promise<Booking> {
  return rpc<Booking>('freight_assign_vehicle_driver', { p_booking_id: bookingId, p_vehicle_id: vehicleId, p_driver_id: driverId })
}

export async function advanceBooking(bookingId: string, toStatus: BookingStatus, note: string | null, lat?: number | null, lng?: number | null): Promise<Booking> {
  return rpc<Booking>('freight_advance_booking', {
    p_booking_id: bookingId,
    p_to_status: toStatus,
    p_note: note,
    p_lat: lat ?? null,
    p_lng: lng ?? null,
  })
}

export async function cancelBooking(bookingId: string, reason: string): Promise<Booking> {
  return rpc<Booking>('freight_cancel_booking', { p_booking_id: bookingId, p_reason: reason })
}

export async function listBookingEvents(bookingId: string): Promise<BookingEvent[]> {
  return query<BookingEvent[]>(() =>
    sb().from('freight_booking_events').select('*').eq('booking_id', bookingId).order('id', { ascending: true }).limit(500),
  )
}

export async function getLoadById(loadId: string): Promise<FreightLoad | null> {
  const rows = await query<FreightLoad[]>(() => sb().from('freight_loads').select('*').eq('id', loadId))
  return rows[0] ?? null
}
