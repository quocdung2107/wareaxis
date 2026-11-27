// Chuyến đã chốt (Booking) — logic thuần, không DB.
// Nguồn thiết kế: Bản A mục 2.2.9 + 2.6. Máy trạng thái của tài liệu bắt đầu
// ở BOOKED; T1 có thêm hai trạng thái tiền tố do luồng chỉ định trực tiếp:
// PENDING_CONFIRM (chờ nhà xe xác nhận chỉ định) và DECLINED (nhà xe từ chối).
// Sau BOOKED: ARRIVED_PICKUP -> PICKED_UP -> IN_TRANSIT -> ARRIVED_DELIVERY
// -> DELIVERED -> POD_CONFIRMED -> COMPLETED. Nhánh: DISPUTED (một phía gắn
// cờ khi POD/cước không khớp — hai bên tự xử, không có phân xử của sàn),
// CANCELLED chỉ trước PICKED_UP và bắt buộc lý do (RPC/UI kiểm tra lý do).
// DELIVERED -> COMPLETED là đường T1 (chủ hàng xác nhận hoàn thành khi chưa
// dùng POD); POD_CONFIRMED thuộc T3 nhưng đã có trong máy để không phải sửa
// lại khi làm POD.

export const BOOKING_STATUSES = [
  'PENDING_CONFIRM',
  'BOOKED',
  'ARRIVED_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'ARRIVED_DELIVERY',
  'DELIVERED',
  'POD_CONFIRMED',
  'COMPLETED',
  'DISPUTED',
  'CANCELLED',
  'DECLINED',
] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  PENDING_CONFIRM: 'Chờ nhà xe xác nhận',
  BOOKED: 'Đã chốt chuyến',
  ARRIVED_PICKUP: 'Xe đã đến điểm lấy',
  PICKED_UP: 'Đã lấy hàng',
  IN_TRANSIT: 'Đang giao hàng',
  ARRIVED_DELIVERY: 'Đã đến điểm giao',
  DELIVERED: 'Đã giao hàng',
  POD_CONFIRMED: 'Đã xác nhận POD',
  COMPLETED: 'Hoàn thành',
  DISPUTED: 'Đang tranh chấp (hai bên tự xử lý)',
  CANCELLED: 'Đã huỷ',
  DECLINED: 'Nhà xe từ chối',
}

/** Phía thực hiện hành động: chủ hàng / nhà xe / tài xế (tài xế thuộc phía nhà xe). */
export type BookingSide = 'SHIPPER' | 'CARRIER' | 'DRIVER'

export const BOOKING_SIDE_LABELS: Record<BookingSide, string> = {
  SHIPPER: 'Chủ hàng',
  CARRIER: 'Nhà xe',
  DRIVER: 'Tài xế',
}

interface Transition {
  from: BookingStatus
  to: BookingStatus
  sides: readonly BookingSide[]
}

const CARRIER_SIDE: readonly BookingSide[] = ['CARRIER', 'DRIVER']
const BOTH_SIDES: readonly BookingSide[] = ['SHIPPER', 'CARRIER', 'DRIVER']

const TRANSITIONS: readonly Transition[] = [
  // Chỉ định trực tiếp (T1): nhà xe xác nhận hoặc từ chối.
  { from: 'PENDING_CONFIRM', to: 'BOOKED', sides: ['CARRIER'] },
  { from: 'PENDING_CONFIRM', to: 'DECLINED', sides: ['CARRIER'] },
  { from: 'PENDING_CONFIRM', to: 'CANCELLED', sides: ['SHIPPER'] },
  // Chạy chuyến: mốc sự kiện do phía nhà xe/tài xế ghi (PICKED_UP thêm phía
  // chủ hàng — kho xác nhận đã giao hàng cho xe, theo luồng 2.3 bước 9).
  { from: 'BOOKED', to: 'ARRIVED_PICKUP', sides: CARRIER_SIDE },
  { from: 'BOOKED', to: 'CANCELLED', sides: BOTH_SIDES },
  { from: 'ARRIVED_PICKUP', to: 'PICKED_UP', sides: BOTH_SIDES },
  { from: 'ARRIVED_PICKUP', to: 'CANCELLED', sides: BOTH_SIDES },
  { from: 'PICKED_UP', to: 'IN_TRANSIT', sides: CARRIER_SIDE },
  { from: 'IN_TRANSIT', to: 'ARRIVED_DELIVERY', sides: CARRIER_SIDE },
  { from: 'ARRIVED_DELIVERY', to: 'DELIVERED', sides: CARRIER_SIDE },
  // Đóng chuyến: chủ hàng xác nhận (POD ở T3; hoàn thành trực tiếp ở T1).
  { from: 'DELIVERED', to: 'POD_CONFIRMED', sides: ['SHIPPER'] },
  { from: 'DELIVERED', to: 'COMPLETED', sides: ['SHIPPER'] },
  { from: 'DELIVERED', to: 'DISPUTED', sides: BOTH_SIDES },
  { from: 'POD_CONFIRMED', to: 'COMPLETED', sides: ['SHIPPER'] },
  { from: 'POD_CONFIRMED', to: 'DISPUTED', sides: BOTH_SIDES },
  // Tranh chấp do hai bên tự xử: chủ hàng xác nhận lại để đóng.
  { from: 'DISPUTED', to: 'POD_CONFIRMED', sides: ['SHIPPER'] },
  { from: 'DISPUTED', to: 'COMPLETED', sides: ['SHIPPER'] },
]

export function canTransitionBooking(from: BookingStatus, to: BookingStatus, side: BookingSide): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.sides.includes(side))
}

/** Mọi phía được phép thực hiện chuyển đổi from -> to (rỗng = không hợp lệ). */
export function bookingTransitionSides(from: BookingStatus, to: BookingStatus): readonly BookingSide[] {
  return TRANSITIONS.find((t) => t.from === from && t.to === to)?.sides ?? []
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus, side: BookingSide): void {
  if (!canTransitionBooking(from, to, side)) {
    throw new Error(
      `Phía ${BOOKING_SIDE_LABELS[side]} không chuyển được chuyến từ ${BOOKING_STATUS_LABELS[from] ?? from} sang ${BOOKING_STATUS_LABELS[to] ?? to}`,
    )
  }
}

/** Trạng thái kết thúc — không còn hành động nào. */
export const isBookingTerminal = (s: BookingStatus): boolean => s === 'COMPLETED' || s === 'CANCELLED' || s === 'DECLINED'

/** Booking còn "đang sống" (một load chỉ có tối đa một booking đang sống). */
export const isBookingLive = (s: BookingStatus): boolean => !isBookingTerminal(s)

/** Huỷ chuyến chỉ được trước khi lấy hàng (đúng tài liệu 2.6) và bắt buộc lý do. */
export const canCancelBooking = (s: BookingStatus): boolean =>
  s === 'PENDING_CONFIRM' || s === 'BOOKED' || s === 'ARRIVED_PICKUP'

export interface BookingAction {
  to: BookingStatus
  label: string
}

const ACTION_LABELS: Partial<Record<BookingStatus, string>> = {
  BOOKED: 'Xác nhận nhận chuyến',
  DECLINED: 'Từ chối chuyến',
  ARRIVED_PICKUP: 'Đã đến điểm lấy hàng',
  PICKED_UP: 'Xác nhận đã lấy hàng',
  IN_TRANSIT: 'Bắt đầu giao hàng',
  ARRIVED_DELIVERY: 'Đã đến điểm giao',
  DELIVERED: 'Đã giao hàng',
  POD_CONFIRMED: 'Xác nhận POD',
  COMPLETED: 'Hoàn thành chuyến',
  DISPUTED: 'Gắn cờ tranh chấp',
  CANCELLED: 'Huỷ chuyến',
}

/** Các nút hành động UI hiển thị cho một phía ở trạng thái hiện tại. */
export function bookingActionsFor(status: BookingStatus, side: BookingSide): BookingAction[] {
  return TRANSITIONS.filter((t) => t.from === status && t.sides.includes(side)).map((t) => ({
    to: t.to,
    label: ACTION_LABELS[t.to] ?? BOOKING_STATUS_LABELS[t.to],
  }))
}
