// Phân bổ tồn (allocation) cho đơn xuất — thuần, không DB (GĐ2).
// Biến "gợi ý lấy hàng" thành "cam kết tồn": áp allocation = movement ALLOCATE
// (xô allocated của balance tăng, available giảm — xem domain/ledger).
// Ứng viên hợp lệ: lô AVAILABLE, vị trí PICKABLE/BULK đang bật, và số khả dụng
// của balance = on_hand − allocated − hold − damaged − inspect (availableOf) —
// tức bỏ qua phần đang chờ QC (inspect), hàng hỏng (damaged), đóng băng (hold)
// và phần đã giữ chỗ cho đơn khác (allocated).
import { availableOf, roundQty, type StockMovement } from '../ledger/types.ts'

export const ALLOCATION_POLICIES = ['FEFO', 'FIFO', 'FEFO_THEN_FIFO'] as const
export type AllocationPolicy = (typeof ALLOCATION_POLICIES)[number]

export const ALLOCATION_POLICY_LABELS: Record<AllocationPolicy, string> = {
  FEFO: 'FEFO — hết hạn trước xuất trước',
  FIFO: 'FIFO — nhập trước xuất trước',
  FEFO_THEN_FIFO: 'FEFO, hoà thì FIFO (mặc định)',
}

export interface AllocationCandidate {
  lot_id: number
  location_id: number
  location_code?: string
  sku: string
  lot_status: string
  loc_type: string | null
  location_active: number
  /** Ngày hết hạn của lô (YYYY-MM-DD) hoặc null/rỗng khi không theo dõi. */
  expiry_date: string | null
  on_hand: number
  allocated: number
  hold: number
  damaged: number
  inspect: number
  in_transit?: number
}

/** Số còn phân bổ được của một ứng viên (chưa lọc điều kiện lô/vị trí). */
export const candidateAvailable = (c: AllocationCandidate): number =>
  Math.max(0, availableOf({
    on_hand: c.on_hand, allocated: c.allocated, hold: c.hold,
    damaged: c.damaged, inspect: c.inspect, in_transit: c.in_transit ?? 0,
  }))

const PICKABLE_TYPES = new Set(['PICKABLE', 'BULK'])

export function isAllocatableCandidate(c: AllocationCandidate, sku: string): boolean {
  if (c.sku.trim().toUpperCase() !== sku.trim().toUpperCase()) return false
  if (c.lot_status !== 'AVAILABLE') return false
  if (!PICKABLE_TYPES.has(String(c.loc_type ?? ''))) return false
  if (c.location_active === 0) return false
  return candidateAvailable(c) > 0
}

/** So sánh FEFO: expiry tăng dần, lô không có expiry xuống cuối; hoà -> lot_id nhỏ trước. */
function byFefo(a: AllocationCandidate, b: AllocationCandidate): number {
  const ea = a.expiry_date?.trim() ? a.expiry_date : null
  const eb = b.expiry_date?.trim() ? b.expiry_date : null
  if (ea && eb && ea !== eb) return ea < eb ? -1 : 1
  if (ea && !eb) return -1
  if (!ea && eb) return 1
  return a.lot_id - b.lot_id
}

const byFifo = (a: AllocationCandidate, b: AllocationCandidate): number => a.lot_id - b.lot_id

/** Sắp ứng viên theo chính sách (không sửa mảng đầu vào). */
export function sortCandidatesForPolicy(
  candidates: readonly AllocationCandidate[],
  policy: AllocationPolicy,
): AllocationCandidate[] {
  const cmp = policy === 'FIFO' ? byFifo : byFefo // FEFO_THEN_FIFO dùng đúng bộ so FEFO->FIFO
  return [...candidates].sort(cmp)
}

export interface AllocationSlice {
  lot_id: number
  location_id: number
  qty: number
}

export interface AllocationLineResult {
  sku: string
  qty_requested: number
  allocations: AllocationSlice[]
  qty_allocated: number
  /** Phần không phân bổ được (thiếu hàng). */
  backorder: number
}

/**
 * Phân bổ một dòng đơn: lọc ứng viên hợp lệ, sắp theo chính sách, lấy dần tới
 * đủ. Không đủ -> trả backorder phần thiếu (không ném lỗi: thiếu hàng là một
 * kết quả nghiệp vụ bình thường của allocation).
 */
export function allocateLine(
  sku: string,
  qty: number,
  candidates: readonly AllocationCandidate[],
  policy: AllocationPolicy = 'FEFO_THEN_FIFO',
): AllocationLineResult {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Số lượng phân bổ của ${sku} phải lớn hơn 0`)
  const usable = sortCandidatesForPolicy(
    candidates.filter((c) => isAllocatableCandidate(c, sku)),
    policy,
  )
  const allocations: AllocationSlice[] = []
  let remaining = roundQty(qty)
  for (const c of usable) {
    if (remaining <= 0) break
    const take = Math.min(candidateAvailable(c), remaining)
    if (take > 0) {
      allocations.push({ lot_id: c.lot_id, location_id: c.location_id, qty: roundQty(take) })
      remaining = roundQty(remaining - take)
    }
  }
  return {
    sku,
    qty_requested: roundQty(qty),
    allocations,
    qty_allocated: roundQty(qty - remaining),
    backorder: remaining,
  }
}

/** Sinh movements ALLOCATE cho các slice của một dòng đơn (doc = đơn xuất). */
export function buildAllocateMovements(
  slices: readonly AllocationSlice[],
  line: { id: number; sku: string },
  ctx: { order_id: number; warehouse_id: number | null; actor?: string },
): StockMovement[] {
  return slices.map((s) => ({
    type: 'ALLOCATE',
    warehouse_id: ctx.warehouse_id,
    location_id: s.location_id,
    lot_id: s.lot_id,
    sku: line.sku,
    qty: s.qty,
    doc_type: 'PICK_ORDER',
    doc_id: ctx.order_id,
    doc_line_id: line.id,
    actor: ctx.actor ?? 'local',
    note: 'Phân bổ cho đơn xuất',
  }))
}
