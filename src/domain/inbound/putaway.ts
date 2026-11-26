// Gợi ý vị trí cất hàng (putaway) + kế hoạch putaway — thuần, không DB (GĐ1).
// Ưu tiên gợi ý (chốt trong kế hoạch triển khai):
//   (1) vị trí đang chứa cùng SKU (gom hàng về một chỗ),
//   (2) vị trí PICKABLE trống cùng zone với một vị trí đang chứa cùng SKU,
//   (3) vị trí PICKABLE trống bất kỳ, theo pick_sequence,
//   (4) vị trí BULK trống, theo pick_sequence.
// KHÔNG BAO GIỜ gợi ý vị trí loại RECEIVING / DAMAGE / HOLD hoặc vị trí đã tắt.
import { roundQty, type StockMovement } from '../ledger/types.ts'
import { qtyAwaitingPutaway, type ReceiptLineForQc } from './qc.ts'

export interface PutawayLocation {
  id: number
  code: string
  zone_id: number | null
  loc_type: string | null
  pick_sequence: number | null
  active: number
}

/** Một dòng balance rút gọn để biết vị trí nào đang chứa gì. */
export interface LocationStock {
  location_id: number | null
  sku: string
  on_hand: number
}

const NEVER_SUGGEST = new Set(['RECEIVING', 'DAMAGE', 'HOLD'])
const bySequence = (a: PutawayLocation, b: PutawayLocation): number =>
  (a.pick_sequence ?? Number.MAX_SAFE_INTEGER) - (b.pick_sequence ?? Number.MAX_SAFE_INTEGER) ||
  a.code.localeCompare(b.code)

export function suggestPutawayLocation(
  sku: string,
  locations: readonly PutawayLocation[],
  stock: readonly LocationStock[],
): PutawayLocation | null {
  const key = sku.trim().toUpperCase()
  const usable = locations.filter((l) => l.active !== 0 && !NEVER_SUGGEST.has(String(l.loc_type ?? '')))
  if (usable.length === 0) return null

  const qtyAt = new Map<number, number>()
  const skuAt = new Set<number>()
  for (const s of stock) {
    if (s.location_id == null || !(s.on_hand > 0)) continue
    qtyAt.set(s.location_id, (qtyAt.get(s.location_id) ?? 0) + s.on_hand)
    if (s.sku.trim().toUpperCase() === key) skuAt.add(s.location_id)
  }
  const usableById = new Map(usable.map((l) => [l.id, l]))
  const empty = (l: PutawayLocation) => !(qtyAt.get(l.id) ?? 0)

  // (1) đang chứa cùng SKU
  const sameSku = [...skuAt].map((id) => usableById.get(id)).filter((l): l is PutawayLocation => !!l).sort(bySequence)
  if (sameSku.length) return sameSku[0]

  // (2) PICKABLE trống cùng zone với vị trí chứa cùng SKU (zone lấy từ mọi vị trí, kể cả khu nhận)
  const skuZones = new Set(
    locations.filter((l) => skuAt.has(l.id)).map((l) => l.zone_id).filter((z) => z != null),
  )
  const sameZone = usable
    .filter((l) => l.loc_type === 'PICKABLE' && l.zone_id != null && skuZones.has(l.zone_id) && empty(l))
    .sort(bySequence)
  if (sameZone.length) return sameZone[0]

  // (3) PICKABLE trống bất kỳ
  const pickable = usable.filter((l) => l.loc_type === 'PICKABLE' && empty(l)).sort(bySequence)
  if (pickable.length) return pickable[0]

  // (4) BULK trống
  const bulk = usable.filter((l) => l.loc_type === 'BULK' && empty(l)).sort(bySequence)
  if (bulk.length) return bulk[0]

  return null
}

export interface PutawayPlan {
  qty: number
  to_location_id: number
  movements: StockMovement[]
}

export type PutawayResult = { ok: true; plan: PutawayPlan } | { ok: false; error: string }

/**
 * Lập kế hoạch cất `qty` của một dòng nhận (đã QC đạt) từ vị trí nhận sang
 * vị trí đích. Sinh movement PUTAWAY hai phía (from_location_id = vị trí nhận).
 */
export function planPutaway(
  line: ReceiptLineForQc,
  input: { qty: number; to_location_id: number },
  ctx: { warehouse_id: number | null; receiving_location_id: number; actor?: string },
  locations: readonly PutawayLocation[],
): PutawayResult {
  const fail = (error: string): PutawayResult => ({ ok: false, error })
  const qty = input.qty
  if (!Number.isFinite(qty) || !(qty > 0)) return fail('Số lượng cất phải lớn hơn 0')
  const awaiting = qtyAwaitingPutaway(line)
  if (roundQty(qty) > awaiting + 1e-9) return fail(`Cất vượt số đã QC đạt chưa cất: ${qty} > ${awaiting}`)
  const dest = locations.find((l) => l.id === input.to_location_id)
  if (!dest) return fail('Không tìm thấy vị trí đích')
  if (dest.active === 0) return fail(`Vị trí ${dest.code} đang tắt`)
  if (NEVER_SUGGEST.has(String(dest.loc_type ?? ''))) {
    return fail(`Không cất hàng vào vị trí loại ${dest.loc_type} (${dest.code})`)
  }
  if (dest.id === ctx.receiving_location_id) return fail('Vị trí đích trùng vị trí nhận hàng')
  return {
    ok: true,
    plan: {
      qty,
      to_location_id: dest.id,
      movements: [{
        type: 'PUTAWAY',
        warehouse_id: ctx.warehouse_id,
        location_id: dest.id,
        from_location_id: ctx.receiving_location_id,
        lot_id: line.lot_id,
        sku: line.sku,
        qty,
        doc_type: 'RECEIPT',
        doc_id: line.receipt_id,
        doc_line_id: line.id,
        actor: ctx.actor ?? 'local',
        note: `Cất hàng vào ${dest.code}`,
      }],
    },
  }
}
