// Trung tâm cảnh báo kho — quét THUẦN từ dữ liệu đưa vào, không DB (GĐ3).
// "Hôm nay" là THAM SỐ (today, dạng YYYY-MM-DD) để test tất định; tầng gọi tự
// lấy ngày local. Mỗi cảnh báo có alert_key ổn định (type:sku:lot:location)
// để scan lại upsert theo khoá, không sinh trùng; cảnh báo hết điều kiện sẽ
// được tầng ghi tự chuyển RESOLVED.
// PENDING_QC: dùng điều kiện inspect > 0 đơn thuần — balances không có mốc
// thời gian riêng cho xô inspect (updated_at bị mọi movement chạm vào), nên
// không suy luận "quá 48h" từ dữ liệu không tin cậy.
import { availableOf, roundQty } from '../ledger/types.ts'

export const ALERT_TYPES = [
  'EXPIRY_EXPIRED', 'EXPIRY_7', 'EXPIRY_15', 'EXPIRY_30',
  'LOW_STOCK', 'OUT_OF_STOCK', 'PENDING_QC', 'FROZEN_STOCK',
] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export type AlertSeverity = 'INFO' | 'WARN' | 'CRITICAL'

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  EXPIRY_EXPIRED: 'Đã hết hạn dùng',
  EXPIRY_7: 'Hết hạn trong 7 ngày',
  EXPIRY_15: 'Hết hạn trong 15 ngày',
  EXPIRY_30: 'Hết hạn trong 30 ngày',
  LOW_STOCK: 'Tồn thấp dưới mức min',
  OUT_OF_STOCK: 'Hết hàng (khả dụng = 0)',
  PENDING_QC: 'Hàng chờ QC',
  FROZEN_STOCK: 'Hàng đang đóng băng',
}

export interface LotForAlert {
  lot_id: number
  sku: string
  expiry_date: string | null
}

export interface BalanceForAlert {
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
  on_hand: number
  allocated: number
  hold: number
  damaged: number
  inspect: number
  in_transit: number
}

export interface PolicyForAlert {
  sku: string
  warehouse_id: number | null
  min_qty: number | null
  reorder_point: number | null
}

export interface AlertDraft {
  alert_key: string
  type: AlertType
  severity: AlertSeverity
  sku: string
  lot_id: number | null
  location_id: number | null
  message: string
}

const keyOf = (type: AlertType, sku: string, lotId: number | null, locationId: number | null) =>
  `${type}:${sku.trim().toUpperCase()}:${lotId ?? ''}:${locationId ?? ''}`

/** Số ngày từ today tới date (cùng định dạng YYYY-MM-DD); âm = đã qua. */
export function daysUntil(today: string, date: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, (m || 1) - 1, d || 1) / 86400000
  }
  return Math.round(parse(date) - parse(today))
}

export function scanAlerts(input: {
  lots: readonly LotForAlert[]
  balances: readonly BalanceForAlert[]
  policies: readonly PolicyForAlert[]
  today: string
}): AlertDraft[] {
  const { lots, balances, policies, today } = input
  const out: AlertDraft[] = []

  // --- Hết hạn: gộp on_hand theo lô; mỗi lô chỉ sinh MỘT cảnh báo nặng nhất ---
  const onHandByLot = new Map<number, number>()
  for (const b of balances) {
    if (b.lot_id == null) continue
    onHandByLot.set(b.lot_id, roundQty((onHandByLot.get(b.lot_id) ?? 0) + b.on_hand))
  }
  for (const lot of lots) {
    const expiry = lot.expiry_date?.trim()
    if (!expiry) continue
    const onHand = onHandByLot.get(lot.lot_id) ?? 0
    if (onHand <= 0) continue
    const days = daysUntil(today, expiry)
    let type: AlertType | null = null
    let severity: AlertSeverity = 'INFO'
    if (days < 0) { type = 'EXPIRY_EXPIRED'; severity = 'CRITICAL' }
    else if (days <= 7) { type = 'EXPIRY_7'; severity = 'CRITICAL' }
    else if (days <= 15) { type = 'EXPIRY_15'; severity = 'WARN' }
    else if (days <= 30) { type = 'EXPIRY_30'; severity = 'INFO' }
    if (!type) continue
    out.push({
      alert_key: keyOf(type, lot.sku, lot.lot_id, null),
      type, severity, sku: lot.sku, lot_id: lot.lot_id, location_id: null,
      message: days < 0
        ? `Lô ${lot.lot_id} (${lot.sku}) đã hết hạn ngày ${expiry}, còn tồn vật lý ${onHand}`
        : `Lô ${lot.lot_id} (${lot.sku}) hết hạn ngày ${expiry} (còn ${days} ngày), còn tồn vật lý ${onHand}`,
    })
  }

  // --- Chờ QC / đóng băng: theo từng balance ---
  for (const b of balances) {
    if (b.inspect > 0) {
      out.push({
        alert_key: keyOf('PENDING_QC', b.sku, b.lot_id, b.location_id),
        type: 'PENDING_QC', severity: 'WARN', sku: b.sku,
        lot_id: b.lot_id, location_id: b.location_id,
        message: `${b.sku} còn ${b.inspect} đang chờ QC tại vị trí ${b.location_id ?? '—'} (lô ${b.lot_id ?? '—'})`,
      })
    }
    if (b.hold > 0) {
      out.push({
        alert_key: keyOf('FROZEN_STOCK', b.sku, b.lot_id, b.location_id),
        type: 'FROZEN_STOCK', severity: 'INFO', sku: b.sku,
        lot_id: b.lot_id, location_id: b.location_id,
        message: `${b.sku} đang đóng băng ${b.hold} tại vị trí ${b.location_id ?? '—'} (lô ${b.lot_id ?? '—'})`,
      })
    }
  }

  // --- Tồn thấp / hết hàng: theo policy x SKU (gộp khả dụng mọi vị trí của kho) ---
  const availByWhSku = new Map<string, number>()
  for (const b of balances) {
    const k = `${b.warehouse_id ?? ''}\u0001${b.sku.trim().toUpperCase()}`
    availByWhSku.set(k, roundQty((availByWhSku.get(k) ?? 0) + availableOf(b)))
  }
  for (const p of policies) {
    const threshold = p.min_qty ?? p.reorder_point ?? null
    if (threshold == null) continue
    const available = availByWhSku.get(`${p.warehouse_id ?? ''}\u0001${p.sku.trim().toUpperCase()}`) ?? 0
    if (available <= 0) {
      out.push({
        alert_key: keyOf('OUT_OF_STOCK', p.sku, null, null),
        type: 'OUT_OF_STOCK', severity: 'CRITICAL', sku: p.sku, lot_id: null, location_id: null,
        message: `${p.sku} đã hết hàng khả dụng (mức min ${threshold})`,
      })
    } else if (available < threshold) {
      out.push({
        alert_key: keyOf('LOW_STOCK', p.sku, null, null),
        type: 'LOW_STOCK', severity: 'WARN', sku: p.sku, lot_id: null, location_id: null,
        message: `${p.sku} tồn khả dụng ${available} dưới mức min ${threshold}`,
      })
    }
  }

  const sevRank: Record<AlertSeverity, number> = { CRITICAL: 0, WARN: 1, INFO: 2 }
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.alert_key.localeCompare(b.alert_key))
}
