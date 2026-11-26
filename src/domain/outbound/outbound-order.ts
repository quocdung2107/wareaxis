// Đơn xuất kho (outbound order) — logic thuần, không DB (kế hoạch v2 Phần 5.3D, GĐ2).
// Chỉ áp cho hàng LEDGER (lots/stock_balances từ GĐ1). Luồng lấy hàng cũ cho
// hàng nạp file (pick_orders/pick_sessions trên inventory_rows) giữ nguyên,
// không liên quan tới đơn xuất ở đây.
// Vòng đời: DRAFT -> ALLOCATED (đủ) / PARTIAL_ALLOCATED (thiếu, có backorder)
//   -> PICKING -> PACKED -> SHIPPED -> COMPLETED; CANCELLED chỉ khi chưa pick.
// SHIPPED -> COMPLETED được gộp ngay khi giao (MVP): trạng thái lưu cuối là
// COMPLETED, phiếu giao (shipments) mang trạng thái SHIPPED.
import { roundQty } from '../ledger/types.ts'

export const OB_STATUSES = [
  'DRAFT', 'ALLOCATED', 'PARTIAL_ALLOCATED', 'PICKING', 'PACKED', 'SHIPPED', 'COMPLETED', 'CANCELLED',
] as const
export type ObStatus = (typeof OB_STATUSES)[number]

export const OB_STATUS_LABELS: Record<ObStatus, string> = {
  DRAFT: 'Nháp',
  ALLOCATED: 'Đã phân bổ đủ',
  PARTIAL_ALLOCATED: 'Phân bổ một phần (thiếu hàng)',
  PICKING: 'Đang lấy hàng',
  PACKED: 'Đã đóng gói',
  SHIPPED: 'Đã giao xe',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã huỷ',
}

export const OB_SOURCES = ['MANUAL', 'SUPABASE'] as const
export type ObSource = (typeof OB_SOURCES)[number]

const TRANSITIONS: Record<ObStatus, readonly ObStatus[]> = {
  DRAFT: ['ALLOCATED', 'PARTIAL_ALLOCATED', 'CANCELLED'],
  ALLOCATED: ['PICKING', 'CANCELLED'],
  PARTIAL_ALLOCATED: ['ALLOCATED', 'PICKING', 'CANCELLED'],
  PICKING: ['PACKED'],
  PACKED: ['SHIPPED'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
}

export function canTransitionOb(from: ObStatus, to: ObStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function assertObTransition(from: ObStatus, to: ObStatus): void {
  if (!canTransitionOb(from, to)) {
    throw new Error(`Không chuyển được đơn xuất từ ${OB_STATUS_LABELS[from] ?? from} sang ${OB_STATUS_LABELS[to] ?? to}`)
  }
}

/** Huỷ được khi chưa lấy hàng dòng nào (trạng thái chưa qua PICKING). */
export const isCancellable = (s: ObStatus): boolean =>
  s === 'DRAFT' || s === 'ALLOCATED' || s === 'PARTIAL_ALLOCATED'

export interface OutboundLineInput {
  sku: string
  description?: string
  uom?: string
  qty_ordered: number
  note?: string
}

export interface OutboundOrderInput {
  source?: ObSource
  /** Mã đơn bên Supabase Orders (chỉ lưu tham chiếu, không đồng bộ hai chiều). */
  external_ref?: string
  customer_name?: string
  customer_code?: string
  warehouse_id?: number | null
  carrier_text?: string
  note?: string
  lines: OutboundLineInput[]
}

/** Trả chuỗi lỗi đầu tiên, hoặc null khi hợp lệ. */
export function validateOutboundInput(input: OutboundOrderInput): string | null {
  if (input.source && !(OB_SOURCES as readonly string[]).includes(input.source)) {
    return `Nguồn đơn không hợp lệ: ${input.source}`
  }
  if (!input.lines || input.lines.length === 0) return 'Đơn xuất phải có ít nhất 1 dòng hàng'
  for (const [i, l] of input.lines.entries()) {
    if (!l.sku?.trim()) return `Dòng ${i + 1}: chưa nhập SKU`
    if (!Number.isFinite(l.qty_ordered) || l.qty_ordered <= 0) {
      return `Dòng ${i + 1} (${l.sku}): số lượng xuất phải lớn hơn 0`
    }
  }
  return null
}

export interface ObLineAllocState {
  qty_ordered: number
  /** Tổng đang giữ chỗ (allocations ACTIVE/PICKED/SHORT chưa ship) + đã lấy. */
  qty_allocated: number
}

/**
 * Trạng thái đơn sau một lần phân bổ (xét tổng giữ chỗ của mọi dòng):
 * đủ mọi dòng -> ALLOCATED; có giữ chỗ nhưng thiếu -> PARTIAL_ALLOCATED
 * (kể cả thiếu toàn bộ: đã chạy phân bổ mà không có hàng).
 */
export function obStatusAfterAllocation(lines: readonly ObLineAllocState[]): ObStatus {
  const full = lines.length > 0 && lines.every((l) => roundQty(l.qty_allocated) + 1e-9 >= l.qty_ordered)
  return full ? 'ALLOCATED' : 'PARTIAL_ALLOCATED'
}

/**
 * Phần thiếu (backorder) của một dòng. Quy ước cột qty_allocated trên dòng =
 * tổng đã cam kết (đang giữ chỗ + đã lấy + đã giao; nhả giữ chỗ khi lấy thiếu /
 * huỷ đơn thì trừ lại) — nên backorder = đặt − cam kết.
 */
export const lineBackorder = (l: { qty_ordered: number; qty_allocated: number }): number =>
  roundQty(Math.max(0, l.qty_ordered - l.qty_allocated))
