// Hàng trả về (returns) — thuần, không DB (GĐ2).
// Hàng trả đi ĐÚNG luồng GĐ1: RETURN_IN (into_inspect) về vị trí nhận của lô
// GỐC (truy vết đúng lô đã giao), rồi QC bằng planQc và cất bằng planPutaway
// của domain/inbound — file này chỉ bọc lại (import, không copy logic) và đổi
// doc_type của movements từ RECEIPT sang RETURN cho đúng chứng từ.
import { roundQty, type StockMovement } from '../ledger/types.ts'
import {
  planQc, qtyAwaitingPutaway, qtyPendingQc,
  type QcContext, type QcResult, type ReceiptLineForQc,
} from '../inbound/qc.ts'
import { planPutaway, type PutawayLocation, type PutawayResult } from '../inbound/putaway.ts'

export const RETURN_STATUSES = ['RECEIVED', 'QC_DONE', 'DONE'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  RECEIVED: 'Đã nhận hàng trả (chờ QC)',
  QC_DONE: 'Đã QC (chờ cất hàng)',
  DONE: 'Hoàn tất',
}

export interface ShipmentItemForReturn {
  id: number
  sku: string
  /** Lô gốc đã giao — hàng trả về đúng lô này. null = không rõ lô gốc. */
  lot_id: number | null
  qty_shipped: number
  /** Đã trả ở các phiếu trước. */
  qty_returned: number
}

export interface ReturnPlan {
  qty: number
  movements: StockMovement[]
}

export type ReturnResult = { ok: true; plan: ReturnPlan } | { ok: false; error: string }

/**
 * Lập kế hoạch nhận hàng trả cho một dòng phiếu giao: validate SL trả không
 * vượt SL đã giao còn lại, sinh movement RETURN_IN vào xô inspect tại vị trí
 * nhận, gắn lô gốc.
 */
export function planReturn(
  item: ShipmentItemForReturn,
  qty: number,
  ctx: { warehouse_id: number | null; receiving_location_id: number; return_id: number; actor?: string },
): ReturnResult {
  const fail = (error: string): ReturnResult => ({ ok: false, error })
  if (!Number.isFinite(qty) || qty <= 0) return fail('Số lượng trả phải lớn hơn 0')
  const remaining = roundQty(item.qty_shipped - item.qty_returned)
  if (roundQty(qty) > remaining + 1e-9) {
    return fail(`Trả vượt số đã giao còn lại của ${item.sku}: ${qty} > ${remaining}`)
  }
  return {
    ok: true,
    plan: {
      qty,
      movements: [{
        type: 'RETURN_IN',
        into_inspect: true,
        warehouse_id: ctx.warehouse_id,
        location_id: ctx.receiving_location_id,
        lot_id: item.lot_id,
        sku: item.sku,
        qty,
        doc_type: 'RETURN',
        doc_id: ctx.return_id,
        doc_line_id: item.id,
        actor: ctx.actor ?? 'local',
        note: 'Hàng khách trả về — chờ QC',
      }],
    },
  }
}

/**
 * Dòng trả dưới dạng "dòng chờ QC" — cùng hình dạng ReceiptLineForQc của GĐ1
 * (receipt_id ở đây mang id phiếu trả) để dùng chung planQc/planPutaway.
 */
export type ReturnLineForQc = ReceiptLineForQc

const asReturnDoc = (movements: StockMovement[], returnId: number): StockMovement[] =>
  movements.map((m) => ({ ...m, doc_type: 'RETURN', doc_id: returnId }))

/** QC dòng trả — dùng planQc của inbound, movements ghi doc RETURN. */
export function planReturnQc(
  line: ReturnLineForQc,
  input: { qty_pass: number; qty_fail: number; reason_code?: string | null },
  ctx: QcContext,
): QcResult {
  const r = planQc(line, input, ctx)
  if (!r.ok) return r
  return { ok: true, plan: { ...r.plan, movements: asReturnDoc(r.plan.movements, line.receipt_id) } }
}

/** Cất dòng trả đã QC đạt — dùng planPutaway của inbound, movements ghi doc RETURN. */
export function planReturnPutaway(
  line: ReturnLineForQc,
  input: { qty: number; to_location_id: number },
  ctx: { warehouse_id: number | null; receiving_location_id: number; actor?: string },
  locations: readonly PutawayLocation[],
): PutawayResult {
  const r = planPutaway(line, input, ctx, locations)
  if (!r.ok) return r
  return { ok: true, plan: { ...r.plan, movements: asReturnDoc(r.plan.movements, line.receipt_id) } }
}

/** Trạng thái phiếu trả suy từ tiến độ QC/cất của các dòng. */
export function returnStatusAfter(
  lines: readonly { qty_received: number; qty_qc_pass: number; qty_qc_fail: number; qty_putaway: number }[],
): ReturnStatus {
  const adapters: ReturnLineForQc[] = lines.map((l, i) => ({
    id: i, receipt_id: 0, sku: '', lot_id: null,
    qty_received: l.qty_received, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
  }))
  const qcDone = adapters.every((l) => qtyPendingQc(l) <= 0)
  if (!qcDone) return 'RECEIVED'
  const putDone = adapters.every((l) => qtyAwaitingPutaway(l) <= 0)
  return putDone ? 'DONE' : 'QC_DONE'
}
