// Kiểm kê quay vòng (cycle count) cho hàng LEDGER — thuần, không DB (GĐ3).
// Khác phiếu kiểm mù cũ trên inventory_rows (count_sessions, giữ nguyên):
// phiên ở đây snapshot từ stock_balances, chênh lệch chỉ được áp vào tồn sau
// khi DUYỆT (movement ADJUST_IN/ADJUST_OUT với reason COUNT_VARIANCE).
// Chỉ đếm xô on_hand: expected_qty = on_hand; hold/inspect snapshot riêng để
// đối chiếu khi đếm, KHÔNG tính vào chênh lệch.
import { roundQty, type StockMovement } from '../ledger/types.ts'

export const COUNT_SCOPES = ['LOCATION', 'ZONE', 'SKU'] as const
export type CountScopeType = (typeof COUNT_SCOPES)[number]

export const COUNT_STATUSES = ['OPEN', 'COUNTED', 'APPROVED', 'REJECTED', 'APPLIED'] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]

export const COUNT_STATUS_LABELS: Record<CountStatus, string> = {
  OPEN: 'Đang đếm',
  COUNTED: 'Đã đếm xong — chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Bị từ chối — đếm lại',
  APPLIED: 'Đã áp chênh lệch vào tồn',
}

export interface CountScope {
  type: CountScopeType
  location_id?: number | null
  zone_id?: number | null
  sku?: string | null
  warehouse_id?: number | null
}

/** Một dòng balance đưa vào snapshot (tầng ghi join thêm zone_id từ locations). */
export interface BalanceForCount {
  warehouse_id: number | null
  location_id: number | null
  zone_id?: number | null
  lot_id: number | null
  sku: string
  on_hand: number
  hold: number
  inspect: number
}

export interface CountTaskDraft {
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
  expected_qty: number
  hold_qty: number
  inspect_qty: number
}

const inScope = (b: BalanceForCount, scope: CountScope): boolean => {
  if (scope.warehouse_id != null && b.warehouse_id !== scope.warehouse_id) return false
  switch (scope.type) {
    case 'LOCATION':
      return scope.location_id != null && b.location_id === scope.location_id
    case 'ZONE':
      return scope.zone_id != null && b.zone_id === scope.zone_id
    case 'SKU':
      return !!scope.sku && b.sku.trim().toUpperCase() === scope.sku.trim().toUpperCase()
  }
}

/**
 * Sinh dòng kiểm từ balances trong phạm vi: chỉ dòng còn hàng vật lý hoặc đang
 * đóng băng (on_hand > 0 hoặc hold > 0). Sắp theo vị trí -> SKU -> lô để đi
 * đếm theo một lộ trình ổn định.
 */
export function buildCountTasks(
  balances: readonly BalanceForCount[],
  scope: CountScope,
): CountTaskDraft[] {
  return balances
    .filter((b) => inScope(b, scope) && (b.on_hand > 0 || b.hold > 0))
    .map((b) => ({
      warehouse_id: b.warehouse_id,
      location_id: b.location_id,
      lot_id: b.lot_id,
      sku: b.sku,
      expected_qty: roundQty(b.on_hand),
      hold_qty: roundQty(b.hold),
      inspect_qty: roundQty(b.inspect),
    }))
    .sort((a, b) =>
      (a.location_id ?? 0) - (b.location_id ?? 0)
      || a.sku.localeCompare(b.sku)
      || (a.lot_id ?? 0) - (b.lot_id ?? 0))
}

/** Chênh lệch một dòng: đếm thực tế trừ sổ sách (chỉ trên xô on_hand). */
export const computeVariance = (expectedQty: number, countedQty: number): number =>
  roundQty(countedQty - expectedQty)

export interface CountTaskForAdjust {
  id: number
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
  expected_qty: number
  counted_qty: number | null
}

/**
 * Lập movements điều chỉnh từ các dòng ĐÃ đếm: dòng lệch dương -> ADJUST_IN,
 * lệch âm -> ADJUST_OUT, đúng số -> không movement. Mọi movement mang
 * reason_code COUNT_VARIANCE (bắt buộc ở tầng ledger cho ADJUST_*).
 * Ném lỗi nếu còn dòng chưa đếm — chưa đếm hết thì chưa được duyệt áp.
 */
export function planCountAdjustments(
  tasks: readonly CountTaskForAdjust[],
  ctx: { count_id: number; actor?: string },
): StockMovement[] {
  const movements: StockMovement[] = []
  for (const t of tasks) {
    if (t.counted_qty == null || !Number.isFinite(t.counted_qty)) {
      throw new Error(`Dòng kiểm ${t.sku} (lô ${t.lot_id ?? '—'}) chưa nhập số đếm`)
    }
    if (t.counted_qty < 0) throw new Error(`Số đếm của ${t.sku} không được âm`)
    const variance = computeVariance(t.expected_qty, t.counted_qty)
    if (variance === 0) continue
    movements.push({
      type: variance > 0 ? 'ADJUST_IN' : 'ADJUST_OUT',
      warehouse_id: t.warehouse_id,
      location_id: t.location_id,
      lot_id: t.lot_id,
      sku: t.sku,
      qty: Math.abs(variance),
      reason_code: 'COUNT_VARIANCE',
      doc_type: 'COUNT',
      doc_id: ctx.count_id,
      doc_line_id: t.id,
      actor: ctx.actor ?? 'local',
      note: `Kiểm kê quay vòng: sổ ${t.expected_qty}, đếm ${t.counted_qty}`,
    })
  }
  return movements
}

/** Phiên đã đếm xong chưa (mọi dòng có số đếm). */
export const allCounted = (tasks: readonly { counted_qty: number | null }[]): boolean =>
  tasks.length > 0 && tasks.every((t) => t.counted_qty != null && Number.isFinite(t.counted_qty))
