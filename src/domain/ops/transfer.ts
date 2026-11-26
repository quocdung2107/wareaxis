// Chuyển vị trí trong kho (MOVE) + phiếu chuyển kho (TRANSFER_OUT/IN) —
// thuần, không DB (GĐ3). Phần di chuyển được của một balance là phần KHẢ DỤNG
// (availableOf = on_hand − allocated − hold − damaged − inspect): không chuyển
// phần đã giữ chỗ cho đơn, đang đóng băng, hỏng hay chờ QC.
import { availableOf, roundQty, type StockBuckets, type StockMovement } from '../ledger/types.ts'

export interface MoveSource extends StockBuckets {
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
}

export type MoveResult = { ok: true; movement: StockMovement } | { ok: false; error: string }

/** Số lượng di chuyển được tối đa từ một balance (phần khả dụng). */
export const movableQty = (b: StockBuckets): number => Math.max(0, availableOf(b))

export function planMove(
  source: MoveSource,
  input: { qty: number; to_location_id: number },
  ctx: { actor?: string; doc_id?: number | null; doc_line_id?: number | null } = {},
): MoveResult {
  const fail = (error: string): MoveResult => ({ ok: false, error })
  const qty = input.qty
  if (!Number.isFinite(qty) || qty <= 0) return fail('Số lượng chuyển phải lớn hơn 0')
  if (source.location_id == null) return fail('Dòng tồn chưa có vị trí nguồn')
  if (input.to_location_id === source.location_id) return fail('Vị trí đích trùng vị trí nguồn')
  const movable = movableQty(source)
  if (roundQty(qty) > movable + 1e-9) {
    return fail(`Chuyển vượt phần di chuyển được: cần ${qty}, di chuyển được ${movable} (đã trừ giữ chỗ/đóng băng/hỏng/chờ kiểm)`)
  }
  return {
    ok: true,
    movement: {
      type: 'MOVE',
      warehouse_id: source.warehouse_id,
      location_id: input.to_location_id,
      from_location_id: source.location_id,
      lot_id: source.lot_id,
      sku: source.sku,
      qty: roundQty(qty),
      doc_type: ctx.doc_id != null ? 'TRANSFER' : 'MANUAL',
      doc_id: ctx.doc_id ?? null,
      doc_line_id: ctx.doc_line_id ?? null,
      note: 'Chuyển vị trí trong kho',
      actor: ctx.actor ?? 'local',
    },
  }
}

// ---------- Phiếu chuyển kho ----------
export const TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT', 'DONE', 'CANCELLED'] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  DRAFT: 'Nháp',
  IN_TRANSIT: 'Đang chuyển (đã xuất kho nguồn)',
  DONE: 'Đã nhận kho đích',
  CANCELLED: 'Đã huỷ',
}

const TRANSFER_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  DRAFT: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['DONE'],
  DONE: [],
  CANCELLED: [],
}

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!(TRANSFER_TRANSITIONS[from] ?? []).includes(to)) {
    throw new Error(`Không chuyển được phiếu chuyển kho từ ${TRANSFER_STATUS_LABELS[from] ?? from} sang ${TRANSFER_STATUS_LABELS[to] ?? to}`)
  }
}

export interface TransferLineState {
  id: number
  sku: string
  lot_id: number | null
  from_location_id: number | null
  to_location_id: number | null
  qty: number
}

/**
 * Lập movements TRANSFER_OUT cho bước xuất kho nguồn: mỗi dòng kiểm tra lại
 * phần di chuyển được tại balance nguồn (giữ chỗ/đóng băng có thể đã đổi kể
 * từ lúc tạo phiếu). balances tra theo khoá (lot_id, from_location_id).
 */
export function planTransferOut(
  lines: readonly TransferLineState[],
  balances: readonly MoveSource[],
  ctx: { transfer_id: number; from_warehouse_id: number | null; actor?: string },
): StockMovement[] {
  const movements: StockMovement[] = []
  for (const l of lines) {
    const src = balances.find(
      (b) => b.lot_id === l.lot_id && b.location_id === l.from_location_id
        && b.sku.trim().toUpperCase() === l.sku.trim().toUpperCase(),
    )
    if (!src) throw new Error(`Không thấy tồn của ${l.sku} tại vị trí nguồn của dòng chuyển #${l.id}`)
    const movable = movableQty(src)
    if (roundQty(l.qty) > movable + 1e-9) {
      throw new Error(`Dòng ${l.sku}: xuất chuyển ${l.qty} vượt phần di chuyển được tại nguồn (${movable})`)
    }
    movements.push({
      type: 'TRANSFER_OUT',
      warehouse_id: ctx.from_warehouse_id,
      location_id: l.from_location_id,
      lot_id: l.lot_id,
      sku: l.sku,
      qty: roundQty(l.qty),
      doc_type: 'TRANSFER',
      doc_id: ctx.transfer_id,
      doc_line_id: l.id,
      note: 'Xuất chuyển kho',
      actor: ctx.actor ?? 'local',
    })
  }
  return movements
}

/**
 * Lập movements TRANSFER_IN cho bước nhận kho đích: hai phía — trừ in_transit
 * ở (from_warehouse_id, from_location_id), cộng on_hand ở kho/vị trí đích
 * (tầng ghi ledger xử lý hai phía khi movement có from_location_id).
 */
export function planTransferIn(
  lines: readonly TransferLineState[],
  ctx: { transfer_id: number; from_warehouse_id: number | null; to_warehouse_id: number | null; actor?: string },
): StockMovement[] {
  return lines.map((l) => ({
    type: 'TRANSFER_IN' as const,
    warehouse_id: ctx.to_warehouse_id,
    location_id: l.to_location_id,
    from_location_id: l.from_location_id,
    from_warehouse_id: ctx.from_warehouse_id,
    lot_id: l.lot_id,
    sku: l.sku,
    qty: roundQty(l.qty),
    doc_type: 'TRANSFER' as const,
    doc_id: ctx.transfer_id,
    doc_line_id: l.id,
    note: 'Nhận chuyển kho',
    actor: ctx.actor ?? 'local',
  }))
}
