// QC + putaway cho dòng phiếu nhận — kế hoạch thuần, không DB (GĐ1).
// Luồng xô tồn của hàng PO (xem domain/ledger):
//   RECEIVE(into_inspect) -> inspect --QC FAIL--> DAMAGE(from_inspect) -> damaged
//   inspect --PUTAWAY (khác vị trí)--> on_hand khả dụng tại vị trí đích.
// QC PASS không sinh movement: phần đạt vẫn nằm ở inspect cho tới khi putaway.
import { roundQty, type StockMovement } from '../ledger/types.ts'

export type QcStatus = 'PENDING' | 'PASS' | 'FAIL' | 'PARTIAL'

export interface ReceiptLineForQc {
  id: number
  receipt_id: number
  sku: string
  lot_id: number | null
  qty_received: number
  qty_qc_pass: number
  qty_qc_fail: number
  qty_putaway: number
}

export interface QcContext {
  warehouse_id: number | null
  /** Vị trí nhận hàng — nơi lô đang nằm ở xô inspect. */
  receiving_location_id: number
  actor?: string
}

export interface QcPlan {
  qty_pass: number
  qty_fail: number
  /** Trạng thái QC của dòng sau lần này. */
  qc_status: QcStatus
  /** QC đã xong toàn bộ dòng chưa. */
  qc_complete: boolean
  movements: StockMovement[]
}

export type QcResult = { ok: true; plan: QcPlan } | { ok: false; error: string }

/** Số lượng còn chờ QC trên dòng. */
export const qtyPendingQc = (l: ReceiptLineForQc): number =>
  roundQty(l.qty_received - l.qty_qc_pass - l.qty_qc_fail)

/** Số lượng đã QC đạt nhưng chưa cất lên kệ. */
export const qtyAwaitingPutaway = (l: ReceiptLineForQc): number =>
  roundQty(l.qty_qc_pass - l.qty_putaway)

export function planQc(
  line: ReceiptLineForQc,
  input: { qty_pass: number; qty_fail: number; reason_code?: string | null },
  ctx: QcContext,
): QcResult {
  const fail = (error: string): QcResult => ({ ok: false, error })
  const pass = input.qty_pass
  const bad = input.qty_fail
  if (!Number.isFinite(pass) || pass < 0) return fail('Số lượng đạt QC không hợp lệ')
  if (!Number.isFinite(bad) || bad < 0) return fail('Số lượng hỏng QC không hợp lệ')
  if (pass + bad <= 0) return fail('Chưa nhập số lượng QC (đạt hoặc hỏng)')
  const pending = qtyPendingQc(line)
  if (roundQty(pass + bad) > pending + 1e-9) {
    return fail(`QC vượt số đang chờ: đạt ${pass} + hỏng ${bad} > còn chờ ${pending}`)
  }
  if (bad > 0 && !input.reason_code?.trim()) {
    return fail('Hàng hỏng khi QC bắt buộc chọn lý do (cho movement DAMAGE)')
  }
  const movements: StockMovement[] = []
  if (bad > 0) {
    movements.push({
      type: 'DAMAGE',
      from_inspect: true,
      warehouse_id: ctx.warehouse_id,
      location_id: ctx.receiving_location_id,
      lot_id: line.lot_id,
      sku: line.sku,
      qty: bad,
      reason_code: input.reason_code,
      doc_type: 'RECEIPT',
      doc_id: line.receipt_id,
      doc_line_id: line.id,
      actor: ctx.actor ?? 'local',
      note: 'QC không đạt — chuyển hỏng từ xô chờ kiểm',
    })
  }
  const passTotal = roundQty(line.qty_qc_pass + pass)
  const failTotal = roundQty(line.qty_qc_fail + bad)
  const qc_complete = roundQty(passTotal + failTotal) + 1e-9 >= line.qty_received
  const qc_status: QcStatus = !qc_complete
    ? 'PENDING'
    : failTotal === 0
      ? 'PASS'
      : passTotal === 0
        ? 'FAIL'
        : 'PARTIAL'
  return { ok: true, plan: { qty_pass: pass, qty_fail: bad, qc_status, qc_complete, movements } }
}

/** Trạng thái lô suy từ tiến độ QC/putaway của dòng nhận sinh ra nó. */
export function lotStatusAfter(
  line: ReceiptLineForQc & { qty_qc_pass: number; qty_qc_fail: number; qty_putaway: number },
): 'INSPECT' | 'AVAILABLE' | 'DAMAGED' {
  const qcDone = roundQty(line.qty_qc_pass + line.qty_qc_fail) + 1e-9 >= line.qty_received
  const putDone = roundQty(line.qty_putaway) + 1e-9 >= line.qty_qc_pass
  if (!qcDone || !putDone) return 'INSPECT'
  return line.qty_qc_pass > 0 ? 'AVAILABLE' : 'DAMAGED'
}
