// Đối chiếu tồn sổ cái (ledger) với tồn theo file nạp (MISA/WMS) — GĐ5.
//   ledger_qty: tổng on_hand của SKU từ stock_balances (hàng theo lô, GĐ1+).
//   file_qty: tồn hiển thị của luồng file — công thức tầng dữ liệu nằm ở
//     shared/inventory/reports.ts (Σ inventory_rows.qty_system của kỳ hiện
//     hành − Σ picks kể từ loaded_at của nguồn; inventory_edits đã áp thẳng
//     vào qty_system của dòng nên không trừ thêm — cùng công thức app đang
//     hiển thị, xem history.skuStockInfo).
// Hai thế giới tồn tại song song có chủ đích (hàng nạp file vs hàng theo lô);
// chênh lệch là THÔNG TIN để đối soát, không phải lỗi.
import { roundQty } from '../ledger/types.ts'

export type ReconStatus = 'MATCH' | 'DIFF' | 'ONLY_LEDGER' | 'ONLY_FILE'

export interface ReconRow {
  sku: string
  ledger_qty: number
  file_qty: number
  diff: number // ledger − file
  status: ReconStatus
}

const key = (s: string) => s.trim().toUpperCase()
const EPS = 1e-9

export function buildReconciliation(
  ledgerBySku: ReadonlyMap<string, number> | Record<string, number>,
  fileBySku: ReadonlyMap<string, number> | Record<string, number>,
): ReconRow[] {
  const norm = (src: ReadonlyMap<string, number> | Record<string, number>) => {
    const out = new Map<string, { sku: string; qty: number }>()
    const entries = src instanceof Map ? src.entries() : Object.entries(src)
    for (const [sku, qty] of entries) {
      const k = key(sku)
      const cur = out.get(k)
      out.set(k, { sku: cur?.sku ?? sku, qty: roundQty((cur?.qty ?? 0) + qty) })
    }
    return out
  }
  const ledger = norm(ledgerBySku)
  const file = norm(fileBySku)
  const rows: ReconRow[] = []
  for (const k of new Set([...ledger.keys(), ...file.keys()])) {
    const l = ledger.get(k); const f = file.get(k)
    const ledgerQty = l?.qty ?? 0
    const fileQty = f?.qty ?? 0
    const diff = roundQty(ledgerQty - fileQty)
    const status: ReconStatus = !l ? 'ONLY_FILE' : !f ? 'ONLY_LEDGER' : Math.abs(diff) <= EPS ? 'MATCH' : 'DIFF'
    rows.push({ sku: (l ?? f)!.sku, ledger_qty: ledgerQty, file_qty: fileQty, diff, status })
  }
  return rows.sort((a, b) => key(a.sku).localeCompare(key(b.sku)))
}
