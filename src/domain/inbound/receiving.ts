// Nhận hàng theo PO — kế hoạch thuần, không DB (GĐ1).
// Mỗi dòng nhận SINH MỘT LÔ MỚI (lot_id do tầng ghi cấp từ lot_counter, không tái
// dùng) và một movement RECEIVE với into_inspect=true vào vị trí nhận hàng:
// hàng vào xô inspect, chờ QC — chưa khả dụng, chưa lên kệ.
// Thiếu/thừa tính trên dòng: shortage = max(0, còn phải nhận - đã nhận lần này),
// more = max(0, đã nhận lần này - còn phải nhận).
import { roundQty, type StockMovement } from '../ledger/types.ts'
import { isReceivable, type PoStatus } from './purchase-order.ts'

export interface PoLineForReceiving {
  id: number
  sku: string
  qty_ordered: number
  qty_received: number // đã nhận ở các lần trước
}

export interface ReceiveLineInput {
  po_line_id: number
  qty_received: number
  qty_damaged?: number // hỏng phát hiện ngay khi nhận (vẫn vào inspect, QC quyết định sau)
  batch_no?: string
  lot_no?: string
  manuf_date?: string
  expiry_date?: string
  purchase_price?: number | null
  /** Tầng ghi cấp trước khi lập kế hoạch (từ lot_counter). */
  lot_id?: number | null
}

export interface ReceiptLinePlan {
  po_line_id: number
  sku: string
  lot_id: number | null
  qty_expected: number // còn phải nhận trước lần nhận này
  qty_received: number
  qty_good: number // = qty_received - qty_damaged (tạm coi tốt, QC chốt sau)
  qty_damaged: number
  qty_shortage: number
  qty_more: number
  batch_no: string
  lot_no: string
  manuf_date: string
  expiry_date: string
  purchase_price: number | null
}

export interface ReceivingPlan {
  lines: ReceiptLinePlan[]
  movements: StockMovement[]
  /** Trạng thái PO sau lần nhận này (PARTIAL / RECEIVED). */
  next_po_status: PoStatus
}

export type ReceivingResult = { ok: true; plan: ReceivingPlan } | { ok: false; error: string }

export interface ReceivingContext {
  po_id: number
  po_status: PoStatus
  warehouse_id: number | null
  /** Vị trí nhận hàng (loc_type RECEIVING) — đích của movement RECEIVE. */
  receiving_location_id: number
  actor?: string
}

export function planReceiving(
  poLines: readonly PoLineForReceiving[],
  inputs: readonly ReceiveLineInput[],
  ctx: ReceivingContext,
): ReceivingResult {
  const fail = (error: string): ReceivingResult => ({ ok: false, error })
  if (!isReceivable(ctx.po_status)) return fail(`PO đang ở trạng thái ${ctx.po_status}, không nhận hàng được (cần Đã gửi NCC)`)
  if (inputs.length === 0) return fail('Phiếu nhận trống')
  const byId = new Map(poLines.map((l) => [l.id, l]))
  const seen = new Set<number>()
  const lines: ReceiptLinePlan[] = []
  const movements: StockMovement[] = []

  for (const [i, inp] of inputs.entries()) {
    const n = `Dòng ${i + 1}`
    const line = byId.get(inp.po_line_id)
    if (!line) return fail(`${n}: không tìm thấy dòng PO #${inp.po_line_id}`)
    if (seen.has(inp.po_line_id)) return fail(`${n}: dòng PO #${inp.po_line_id} bị nhập hai lần trong một phiếu`)
    seen.add(inp.po_line_id)
    const received = inp.qty_received
    if (!Number.isFinite(received) || received < 0) return fail(`${n} (${line.sku}): số lượng nhận không hợp lệ`)
    if (received === 0) continue // dòng bỏ qua: không nhận lần này
    const damaged = inp.qty_damaged ?? 0
    if (!Number.isFinite(damaged) || damaged < 0) return fail(`${n} (${line.sku}): số lượng hỏng không hợp lệ`)
    if (damaged > received) return fail(`${n} (${line.sku}): hàng hỏng (${damaged}) vượt quá số nhận (${received})`)

    const expected = roundQty(Math.max(0, line.qty_ordered - line.qty_received))
    const plan: ReceiptLinePlan = {
      po_line_id: line.id,
      sku: line.sku,
      lot_id: inp.lot_id ?? null,
      qty_expected: expected,
      qty_received: received,
      qty_good: roundQty(received - damaged),
      qty_damaged: damaged,
      qty_shortage: roundQty(Math.max(0, expected - received)),
      qty_more: roundQty(Math.max(0, received - expected)),
      batch_no: (inp.batch_no ?? '').trim(),
      lot_no: (inp.lot_no ?? '').trim(),
      manuf_date: (inp.manuf_date ?? '').trim(),
      expiry_date: (inp.expiry_date ?? '').trim(),
      purchase_price: inp.purchase_price ?? null,
    }
    lines.push(plan)
    movements.push({
      type: 'RECEIVE',
      into_inspect: true,
      warehouse_id: ctx.warehouse_id,
      location_id: ctx.receiving_location_id,
      lot_id: plan.lot_id,
      sku: line.sku,
      qty: received,
      doc_type: 'RECEIPT',
      doc_id: ctx.po_id,
      doc_line_id: line.id,
      actor: ctx.actor ?? 'local',
      note: `Nhận theo PO (lô ${plan.batch_no || '—'})`,
    })
  }
  if (lines.length === 0) return fail('Chưa nhập số lượng nhận cho dòng nào')

  const after = poLines.map((l) => {
    const got = lines.find((x) => x.po_line_id === l.id)?.qty_received ?? 0
    return { qty_ordered: l.qty_ordered, qty_received: roundQty(l.qty_received + got) }
  })
  const next_po_status: PoStatus = after.every((l) => l.qty_received + 1e-9 >= l.qty_ordered)
    ? 'RECEIVED'
    : 'PARTIAL'
  return { ok: true, plan: { lines, movements, next_po_status } }
}
