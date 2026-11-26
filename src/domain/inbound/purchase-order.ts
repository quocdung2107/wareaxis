// Đơn mua hàng (PO) — logic thuần, không DB (kế hoạch v2 Phần 5.3C, GĐ1).
// Vòng đời: DRAFT -> SENT -> PARTIAL -> RECEIVED -> CLOSED; CANCELLED chỉ từ
// DRAFT/SENT. PARTIAL/RECEIVED là hệ quả của việc NHẬN HÀNG (rollup từ po_lines),
// không phải nút bấm tay — canTransitionPo cho phép chúng để tầng ghi dùng chung
// một guard, còn UI chỉ hiển thị nút cho các chuyển đổi "tay" (manualTransitions).
import { roundQty } from '../ledger/types.ts'

export const PO_STATUSES = ['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
export type PoStatus = (typeof PO_STATUSES)[number]

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  DRAFT: 'Nháp',
  SENT: 'Đã gửi NCC',
  PARTIAL: 'Đã nhận một phần',
  RECEIVED: 'Đã nhận đủ',
  CLOSED: 'Đã đóng',
  CANCELLED: 'Đã huỷ',
}

const TRANSITIONS: Record<PoStatus, readonly PoStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PARTIAL', 'RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED'],
  RECEIVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
}

/** Chuyển đổi người dùng bấm tay (không gồm PARTIAL/RECEIVED do nhận hàng sinh ra). */
export const MANUAL_TRANSITIONS: Partial<Record<PoStatus, readonly PoStatus[]>> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['CANCELLED'],
  RECEIVED: ['CLOSED'],
}

export function canTransitionPo(from: PoStatus, to: PoStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function assertPoTransition(from: PoStatus, to: PoStatus): void {
  if (!canTransitionPo(from, to)) {
    throw new Error(`Không chuyển được PO từ ${PO_STATUS_LABELS[from] ?? from} sang ${PO_STATUS_LABELS[to] ?? to}`)
  }
}

/** PO ở trạng thái nhận hàng được (đã gửi NCC, chưa nhận đủ). */
export const isReceivable = (s: PoStatus): boolean => s === 'SENT' || s === 'PARTIAL'

export interface PoLineState {
  qty_ordered: number
  qty_received: number
}

/**
 * Suy trạng thái PO sau khi nhận hàng từ các dòng:
 * mọi dòng nhận đủ (qty_received >= qty_ordered) -> RECEIVED;
 * có dòng đã nhận một phần -> PARTIAL; chưa nhận gì -> giữ nguyên.
 */
export function poStatusAfterReceiving(lines: readonly PoLineState[], current: PoStatus): PoStatus {
  if (lines.length === 0) return current
  if (lines.every((l) => l.qty_received + 1e-9 >= l.qty_ordered)) return 'RECEIVED'
  if (lines.some((l) => l.qty_received > 0)) return 'PARTIAL'
  return current
}

export interface PoLineInput {
  sku: string
  description?: string
  uom?: string
  qty_ordered: number
  unit_price?: number | null
  expected_batch?: string
  note?: string
}

export interface PurchaseOrderInput {
  supplier_id?: number | null
  warehouse_id?: number | null
  expected_date?: string
  note?: string
  lines: PoLineInput[]
}

/** Kiểm tra dữ liệu tạo PO; trả thông báo lỗi hoặc null. */
export function validatePoInput(input: PurchaseOrderInput): string | null {
  if (!input.lines || input.lines.length === 0) return 'PO cần ít nhất một dòng hàng'
  for (const [i, l] of input.lines.entries()) {
    const n = `Dòng ${i + 1}`
    if (!l.sku?.trim()) return `${n}: chưa nhập SKU`
    if (!Number.isFinite(l.qty_ordered) || !(l.qty_ordered > 0)) return `${n}: số lượng đặt phải lớn hơn 0`
    if (l.unit_price != null && (!Number.isFinite(l.unit_price) || l.unit_price < 0)) return `${n}: giá mua không hợp lệ`
  }
  return null
}

/** Tổng tiền PO từ các dòng (SL đặt x giá). */
export function poTotal(lines: readonly { qty_ordered: number; unit_price?: number | null }[]): number {
  return roundQty(lines.reduce((s, l) => s + l.qty_ordered * (l.unit_price ?? 0), 0))
}
