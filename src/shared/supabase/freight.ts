// Phần nền dùng chung của lớp trung gian giao tiếp Kho <-> Vận tải.
// Sau khi chuyển sang mô hình tài khoản + quy trình "reset — cài mới"
// (migration gộp 20261128020000_freight_account_model_fresh.sql), toàn
// bộ nghiệp vụ nằm ở freightAccount.ts (RPC freight_acct_*). File này
// chỉ còn:
//   - trạng thái cấu hình + mã lỗi cấu trúc dùng chung (FreightError,
//     freightErrText — freightAccount.ts map tiếp mã mới trên nền này);
//   - kiểu FreightLoad / Booking / BookingEvent (hình dạng dòng của
//     freight_loads / freight_bookings / freight_booking_events);
//   - vài hàm đọc tối thiểu còn nơi dùng: danh sách group của tôi
//     (nguồn tạo tải / chia sẻ tải vào group), đơn của group qua
//     orders_view (tạo tải từ đơn có sẵn), sự kiện chuyến + tải theo id.
// Khi chưa cấu hình Supabase (client null) các hàm ném FreightError mã
// 'unconfigured' để UI hiển thị hướng dẫn thay vì crash.
import { supabase } from './client'
import type { BookingStatus } from '../../domain/freight/booking'
import type { LoadStatus, LoadVisibility } from '../../domain/freight/load'

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
  forbidden: 'Bạn không được làm việc này.',
  invalid_transition: 'Không chuyển trạng thái như vậy được.',
  note_required: 'Thiếu nội dung bắt buộc.',
  reason_required: 'Cần ghi lý do.',
  load_not_found: 'Không tìm thấy tải đăng.',
  load_not_open: 'Tải không còn ở trạng thái đang tìm xe.',
  booking_not_found: 'Không tìm thấy chuyến.',
  carrier_not_found: 'Không tìm thấy hồ sơ nhà xe (tài khoản đó chưa đăng ký hồ sơ hoặc không có vai trò vận tải).',
  invalid_visibility: 'Mức hiển thị không hợp lệ.',
  directed_required: 'Mức "Chỉ định" cần chọn một nhà xe.',
  not_linked: 'Nhà xe này chưa kết nối với bạn (cần hai bên xác nhận kết nối trước, hoặc cùng thuộc một group trao đổi).',
  order_not_in_group: 'Đơn không thuộc nhóm này.',
  warehouse_not_found: 'Không tìm thấy kho.',
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

async function query<T>(fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await fn()
  if (error) throw error
  return data as T
}

// ----- Kiểu dữ liệu (khớp bảng freight_* trong migration fresh) -----

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
  /** T2: tải có nhận chào giá không (mặc định theo mức hiển thị). */
  open_for_bids: boolean
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

// ----- Đọc tối thiểu còn nơi dùng -----

/** Các group tôi là thành viên (nguồn tạo tải từ đơn + chia sẻ tải vào group). */
export async function listMyGroups(): Promise<GroupLite[]> {
  return query<GroupLite[]>(() => sb().from('groups').select('id,name').order('created_at', { ascending: true }))
}

export interface GroupOrderLite {
  id: string
  code: string
  goods: string
  status: string
  shipment_code: string | null
  pickup_address: string | null
  delivery_address: string | null
  weight_kg: number | null
  packages: number | null
}

/**
 * Đơn của nhóm để tạo tải từ đơn có sẵn (điểm chạm Bản A mục 3.6).
 * Đọc qua orders_view như mọi màn hình Orders khác: bảng orders thật
 * (đối chiếu export 2026-11-27) KHÔNG có các cột shipment_code /
 * địa chỉ / cân nặng — các trường đó (nếu view có) được lấy phòng thủ
 * bằng select('*'), thiếu thì để null cho người dùng tự điền vào tải.
 */
export async function listGroupOrders(groupId: string): Promise<GroupOrderLite[]> {
  const rows = await query<Record<string, unknown>[]>(() =>
    sb()
      .from('orders_view')
      .select('*')
      .eq('group_id', groupId)
      .neq('status', 'COMPLETED')
      .order('last_activity_at', { ascending: false })
      .limit(100),
  )
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code ?? ''),
    goods: String(r.goods ?? ''),
    status: String(r.status ?? ''),
    shipment_code: str(r.shipment_code),
    pickup_address: str(r.pickup_address),
    delivery_address: str(r.delivery_address),
    weight_kg: num(r.weight_kg),
    packages: num(r.packages),
  }))
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
