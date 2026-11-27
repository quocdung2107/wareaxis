// Ánh xạ trạng thái lớp giao tiếp -> trạng thái đơn cũ (orders.status).
// Nguồn thiết kế: Bản A mục 2.6. Ánh xạ là MỘT CHIỀU và chỉ tiến về phía
// trước: lớp giao tiếp không bao giờ kéo đơn cũ lùi trạng thái, và đơn không
// qua lớp giao tiếp không bị ảnh hưởng. Trạng thái booking không có dòng
// trong bảng ánh xạ -> null (không đổi trạng thái đơn).
import type { BookingStatus } from './booking.ts'
import type { LoadStatus } from './load.ts'

/** Vòng đời đơn cũ — khớp src/features/orders/statusFlow.ts FLOW. */
export const ORDER_FLOW = ['CREATED', 'CONFIRMED', 'PICKING', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] as const
export type OrderStatus = (typeof ORDER_FLOW)[number]

const BOOKING_TO_ORDER: Partial<Record<BookingStatus, OrderStatus>> = {
  BOOKED: 'CONFIRMED',
  PICKED_UP: 'PICKING',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
}

/** Trạng thái đơn đích khi booking sang `status`; null = giữ nguyên đơn. */
export function bookingToOrderStatus(status: BookingStatus): OrderStatus | null {
  return BOOKING_TO_ORDER[status] ?? null
}

/** Đăng tải (mọi trạng thái load) không tự đổi trạng thái đơn — đơn chỉ đổi khi có booking. */
export function loadToOrderStatus(_status: LoadStatus): OrderStatus | null {
  return null
}

/** Thứ hạng trong vòng đời đơn (để kiểm tra ánh xạ chỉ tiến, không lùi). -1 = không rõ. */
export function orderStatusRank(status: string): number {
  return (ORDER_FLOW as readonly string[]).indexOf(status)
}

/** Ánh xạ có được áp không: đích phải ở sau trạng thái đơn hiện tại. */
export function shouldApplyOrderMapping(currentOrderStatus: string, bookingStatus: BookingStatus): boolean {
  const target = bookingToOrderStatus(bookingStatus)
  if (!target) return false
  const cur = orderStatusRank(currentOrderStatus)
  if (cur < 0) return false
  return orderStatusRank(target) > cur
}
