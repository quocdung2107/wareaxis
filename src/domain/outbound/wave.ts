// Sóng lấy hàng (wave) + xác nhận lấy — thuần, không DB (GĐ2).
// Wave gộp allocations của nhiều đơn: các phần cùng (lô, vị trí) gộp thành 1
// pick task; tasks sắp theo pick_sequence của vị trí (lộ trình lấy hàng).
// Xác nhận lấy cho 1 task: SL thực lấy phân bổ vào các allocation theo thứ tự
// (allocation_id tăng dần); phần task không lấy được -> DEALLOCATE nhả giữ chỗ
// và trở thành backorder của đơn tương ứng.
import { roundQty, type StockMovement } from '../ledger/types.ts'

export interface WaveAllocationInput {
  allocation_id: number
  order_id: number
  order_line_id: number
  lot_id: number
  location_id: number
  location_code: string
  pick_sequence: number | null
  sku: string
  /** Phần còn phải lấy của allocation = qty_allocated − qty_picked. */
  qty_remaining: number
}

export interface PickTaskPart {
  allocation_id: number
  qty: number
}

export interface PickTaskPlan {
  lot_id: number
  location_id: number
  location_code: string
  pick_sequence: number | null
  sku: string
  qty_need: number
  parts: PickTaskPart[]
}

/** Gộp allocations thành pick tasks theo (lô, vị trí), sắp theo lộ trình lấy. */
export function buildPickTasks(inputs: readonly WaveAllocationInput[]): PickTaskPlan[] {
  const groups = new Map<string, PickTaskPlan>()
  for (const a of inputs) {
    if (!(a.qty_remaining > 0)) continue
    const key = `${a.location_id}|${a.lot_id}`
    let g = groups.get(key)
    if (!g) {
      g = {
        lot_id: a.lot_id, location_id: a.location_id, location_code: a.location_code,
        pick_sequence: a.pick_sequence, sku: a.sku, qty_need: 0, parts: [],
      }
      groups.set(key, g)
    }
    g.qty_need = roundQty(g.qty_need + a.qty_remaining)
    const part = g.parts.find((p) => p.allocation_id === a.allocation_id)
    if (part) part.qty = roundQty(part.qty + a.qty_remaining)
    else g.parts.push({ allocation_id: a.allocation_id, qty: roundQty(a.qty_remaining) })
  }
  const tasks = [...groups.values()]
  for (const t of tasks) t.parts.sort((x, y) => x.allocation_id - y.allocation_id)
  tasks.sort((a, b) =>
    (a.pick_sequence ?? Number.MAX_SAFE_INTEGER) - (b.pick_sequence ?? Number.MAX_SAFE_INTEGER) ||
    a.location_code.localeCompare(b.location_code) ||
    a.lot_id - b.lot_id)
  return tasks
}

// ---------- Xác nhận lấy ----------
export interface AllocationPickState {
  allocation_id: number
  order_id: number
  order_line_id: number
  lot_id: number
  location_id: number
  sku: string
  qty_allocated: number
  qty_picked: number
  /** Phần của allocation mà lần xác nhận này bao phủ (phần của task). */
  qty_covered: number
}

export interface PickConfirmSlice {
  allocation_id: number
  qty_pick_now: number
  qty_release: number
  /** Trạng thái allocation sau xác nhận: đủ -> PICKED; thiếu -> SHORT; còn dở -> ACTIVE. */
  new_status: 'PICKED' | 'SHORT' | 'ACTIVE'
  /** qty_allocated hiệu lực sau khi nhả phần thiếu. */
  qty_allocated_after: number
  qty_picked_after: number
}

export interface PickConfirmPlan {
  per_allocation: PickConfirmSlice[]
  movements: StockMovement[]
  task_status: 'PICKED' | 'SHORT'
  total_picked: number
  total_released: number
}

export type PickConfirmResult = { ok: true; plan: PickConfirmPlan } | { ok: false; error: string }

/**
 * Lập kế hoạch xác nhận lấy: qtyActual là tổng SL thực lấy của cả task (hoặc
 * của một allocation khi lấy lẻ không qua wave — truyền 1 state).
 * Phân bổ SL lấy vào các allocation theo thứ tự mảng (tầng ghi truyền theo
 * allocation_id tăng dần); phần bao phủ không lấy được -> nhả giữ chỗ.
 */
export function planPickConfirm(
  states: readonly AllocationPickState[],
  qtyActual: number,
  ctx: { warehouse_id: number | null; actor?: string },
): PickConfirmResult {
  const fail = (error: string): PickConfirmResult => ({ ok: false, error })
  if (states.length === 0) return fail('Không có allocation nào để xác nhận lấy')
  if (!Number.isFinite(qtyActual) || qtyActual < 0) return fail('Số lượng thực lấy không hợp lệ')
  const totalCovered = roundQty(states.reduce((s, x) => s + x.qty_covered, 0))
  if (roundQty(qtyActual) > totalCovered + 1e-9) {
    return fail(`Lấy vượt số đã phân bổ cho task: ${qtyActual} > ${totalCovered}`)
  }
  let remaining = roundQty(qtyActual)
  const per_allocation: PickConfirmSlice[] = []
  const movements: StockMovement[] = []
  for (const st of states) {
    const cap = Math.min(st.qty_covered, roundQty(st.qty_allocated - st.qty_picked))
    const take = Math.min(cap, remaining)
    remaining = roundQty(remaining - take)
    const release = roundQty(cap - take)
    const qty_picked_after = roundQty(st.qty_picked + take)
    const qty_allocated_after = roundQty(st.qty_allocated - release)
    const new_status: PickConfirmSlice['new_status'] =
      qty_picked_after + 1e-9 >= qty_allocated_after
        ? (release > 0 ? 'SHORT' : 'PICKED')
        : 'ACTIVE'
    per_allocation.push({
      allocation_id: st.allocation_id, qty_pick_now: take, qty_release: release,
      new_status, qty_allocated_after, qty_picked_after,
    })
    if (take > 0) {
      movements.push({
        type: 'PICK', warehouse_id: ctx.warehouse_id, location_id: st.location_id,
        lot_id: st.lot_id, sku: st.sku, qty: take,
        doc_type: 'PICK_ORDER', doc_id: st.order_id, doc_line_id: st.order_line_id,
        actor: ctx.actor ?? 'local', note: 'Lấy hàng theo wave/đơn xuất',
      })
    }
    if (release > 0) {
      movements.push({
        type: 'DEALLOCATE', warehouse_id: ctx.warehouse_id, location_id: st.location_id,
        lot_id: st.lot_id, sku: st.sku, qty: release,
        doc_type: 'PICK_ORDER', doc_id: st.order_id, doc_line_id: st.order_line_id,
        actor: ctx.actor ?? 'local', note: 'Lấy thiếu — nhả giữ chỗ về backorder',
      })
    }
  }
  const total_picked = roundQty(per_allocation.reduce((s, x) => s + x.qty_pick_now, 0))
  const total_released = roundQty(per_allocation.reduce((s, x) => s + x.qty_release, 0))
  return {
    ok: true,
    plan: {
      per_allocation, movements,
      task_status: total_released > 0 ? 'SHORT' : 'PICKED',
      total_picked, total_released,
    },
  }
}
