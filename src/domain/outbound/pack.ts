// Đóng gói kiểm chứng (scan-to-verify rút gọn) — thuần, không DB (GĐ2).
// Đối chiếu theo SKU ở cấp ĐƠN: SKU quét/nhập phải thuộc đơn và tổng SL đóng
// gói của SKU đó không vượt SL đã lấy (picked). Đóng gói không sinh movement
// tồn — hàng đã rời on_hand ở bước PICK; pack chỉ là kiểm chứng + ghi nhận.
import { roundQty } from '../ledger/types.ts'

export interface PackLineState {
  sku: string
  qty_picked: number
  qty_packed: number
}

export interface PackScan {
  sku: string
  qty: number
}

const keyOf = (sku: string) => sku.trim().toUpperCase()

/** Cộng dồn picked/packed theo SKU (một đơn có thể có nhiều dòng cùng SKU). */
export function packTotalsBySku(lines: readonly PackLineState[]): Map<string, { picked: number; packed: number }> {
  const m = new Map<string, { picked: number; packed: number }>()
  for (const l of lines) {
    const cur = m.get(keyOf(l.sku)) ?? { picked: 0, packed: 0 }
    cur.picked = roundQty(cur.picked + l.qty_picked)
    cur.packed = roundQty(cur.packed + l.qty_packed)
    m.set(keyOf(l.sku), cur)
  }
  return m
}

export type PackVerifyResult = { ok: true } | { ok: false; error: string }

/** Kiểm một lần quét/nhập so với trạng thái đóng gói hiện tại của đơn. */
export function verifyPackScan(lines: readonly PackLineState[], scan: PackScan): PackVerifyResult {
  if (!scan.sku?.trim()) return { ok: false, error: 'Chưa nhập SKU đóng gói' }
  if (!Number.isFinite(scan.qty) || scan.qty <= 0) {
    return { ok: false, error: `Số lượng đóng gói của ${scan.sku} phải lớn hơn 0` }
  }
  const totals = packTotalsBySku(lines)
  const t = totals.get(keyOf(scan.sku))
  if (!t || t.picked <= 0) {
    return { ok: false, error: `SKU ${scan.sku} không thuộc phần đã lấy của đơn này` }
  }
  if (roundQty(t.packed + scan.qty) > t.picked + 1e-9) {
    return {
      ok: false,
      error: `Đóng gói vượt số đã lấy của ${scan.sku}: đã gói ${t.packed} + ${scan.qty} > đã lấy ${t.picked}`,
    }
  }
  return { ok: true }
}

export interface PackSummary {
  /** Tổng đóng gói theo SKU sau khi áp các scan (gồm phần đã gói trước đó). */
  items: { sku: string; qty_packed: number; qty_picked: number }[]
  /** Mọi SKU đã lấy đều gói đủ và có ít nhất 1 SKU đã lấy. */
  complete: boolean
  /** Tổng SL của riêng các scan lần này theo SKU. */
  scanned: { sku: string; qty: number }[]
}

export type PackSummaryResult = { ok: true; summary: PackSummary } | { ok: false; error: string }

/**
 * Áp một loạt scan lên trạng thái hiện tại (kiểm tra tuần tự, scan sau thấy
 * kết quả của scan trước). Trả tổng kết để tầng ghi cập nhật qty_packed.
 */
export function summarizePack(lines: readonly PackLineState[], scans: readonly PackScan[]): PackSummaryResult {
  const working: PackLineState[] = lines.map((l) => ({ ...l }))
  const scannedMap = new Map<string, { sku: string; qty: number }>()
  for (const scan of scans) {
    const v = verifyPackScan(working, scan)
    if (!v.ok) return v
    // Cộng vào dòng đầu tiên còn thiếu của SKU đó (tầng ghi phân bổ lại y hệt).
    let left = roundQty(scan.qty)
    for (const l of working) {
      if (left <= 0) break
      if (keyOf(l.sku) !== keyOf(scan.sku)) continue
      const room = roundQty(l.qty_picked - l.qty_packed)
      const add = Math.min(room, left)
      l.qty_packed = roundQty(l.qty_packed + add)
      left = roundQty(left - add)
    }
    const cur = scannedMap.get(keyOf(scan.sku)) ?? { sku: scan.sku, qty: 0 }
    cur.qty = roundQty(cur.qty + scan.qty)
    scannedMap.set(keyOf(scan.sku), cur)
  }
  const totals = packTotalsBySku(working)
  const items = [...totals.entries()]
    .filter(([, t]) => t.picked > 0 || t.packed > 0)
    .map(([key, t]) => ({ sku: key, qty_packed: t.packed, qty_picked: t.picked }))
  const complete = items.length > 0 && items.every((i) => roundQty(i.qty_packed) + 1e-9 >= i.qty_picked)
  return { ok: true, summary: { items, complete, scanned: [...scannedMap.values()] } }
}
