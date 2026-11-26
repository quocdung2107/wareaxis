// Sổ cái tồn kho (stock ledger) — kiểu dữ liệu thuần, không DB, không React.
// Nguyên tắc (kế hoạch v2 Phần 5.3B): stock_movements là SỰ THẬT (append-only,
// chỉ INSERT); stock_balances là bản tổng hợp dựng lại được 100% từ movements.

/** Toàn bộ loại biến động tồn. `qty` trên movement luôn DƯƠNG; dấu/xô đích suy từ type. */
export const MOVEMENT_TYPES = [
  'RECEIVE', // nhập hàng: on_hand += qty
  'PUTAWAY', // cất hàng sau QC: inspect -= qty (hàng rời xô chờ kiểm, thành available)
  'ALLOCATE', // giữ chỗ cho đơn: allocated += qty (trừ vào available)
  'DEALLOCATE', // nhả giữ chỗ: allocated -= qty
  'PICK', // lấy hàng: on_hand -= qty; phần allocated tương ứng được tiêu thụ trước
  'MOVE', // chuyển vị trí trong kho: không đổi tổng; ledger áp ở 2 balance (đi/đến)
  'TRANSFER_OUT', // xuất chuyển kho: on_hand -= qty, in_transit += qty
  'TRANSFER_IN', // nhận chuyển kho: in_transit -= qty, on_hand += qty
  'ADJUST_IN', // điều chỉnh tăng (kiểm kê thừa, tìm thấy...): on_hand += qty — BẮT BUỘC reason_code
  'ADJUST_OUT', // điều chỉnh giảm: on_hand -= qty — BẮT BUỘC reason_code
  'FREEZE', // đóng băng: hold += qty (trừ vào available, hàng vẫn nằm trong kho)
  'UNFREEZE', // mở băng: hold -= qty
  'RETURN_IN', // hàng trả về kho: on_hand += qty
  'DAMAGE', // đánh dấu hỏng: damaged += qty (trừ vào available) — BẮT BUỘC reason_code
  'WRITE_OFF', // xuất hủy: on_hand -= qty (trừ xô damaged trước nếu có) — BẮT BUỘC reason_code
  'REVERSAL', // đảo một movement trước đó; áp bằng applyReversal() với movement gốc
] as const

export type MovementType = (typeof MOVEMENT_TYPES)[number]

/** Các "xô" tồn của một balance. available KHÔNG lưu, luôn suy ra. */
export interface StockBuckets {
  on_hand: number // tổng vật lý trong kho (gồm cả allocated/hold/damaged/inspect)
  allocated: number // đã giữ chỗ cho đơn chưa lấy
  hold: number // đóng băng (FREEZE)
  damaged: number // hỏng, không bán được
  inspect: number // chờ QC sau khi nhận, chưa available
  in_transit: number // đang trên đường chuyển kho (không nằm ở vị trí này)
}

/** Tồn khả dụng để bán/phân bổ. */
export const availableOf = (b: StockBuckets): number =>
  roundQty(b.on_hand - b.allocated - b.hold - b.damaged - b.inspect)

/** Làm tròn số lượng 6 chữ số thập phân (tránh bụi số thực như edit.ts r6). */
export const roundQty = (n: number): number => Math.round(n * 1e6) / 1e6

export const emptyBuckets = (): StockBuckets => ({
  on_hand: 0, allocated: 0, hold: 0, damaged: 0, inspect: 0, in_transit: 0,
})

/** Khoá của một balance: kho × vị trí × lô × SKU. null = chưa map master data (luồng cũ). */
export interface BalanceKey {
  warehouse_id: number | null
  location_id: number | null
  lot_id: number | null
  sku: string
}

export interface StockBalance extends BalanceKey, StockBuckets {
  available: number
}

export type DocType = 'PO' | 'RECEIPT' | 'PICK_ORDER' | 'TRANSFER' | 'COUNT' | 'RETURN' | 'MANUAL'

export interface StockMovement extends BalanceKey {
  /** Id dòng sổ cái (khi đã ghi DB); rebuildBalances dùng để REVERSAL tìm movement gốc. */
  id?: number
  /** Số chứng từ biến động, duy nhất (MV-xxxx); null khi tầng ghi tự sinh. */
  movement_no?: string | null
  type: MovementType
  qty: number // luôn > 0
  /** Vị trí nguồn cho MOVE / TRANSFER_OUT (balance đích lấy location_id). */
  from_location_id?: number | null
  /**
   * GĐ3: kho nguồn cho TRANSFER_IN hai phía (chuyển kho): xô in_transit nằm ở
   * balance (from_warehouse_id, from_location_id); balance đích lấy warehouse_id.
   * Thiếu cả hai trường from_* thì TRANSFER_IN áp một phía như cũ.
   */
  from_warehouse_id?: number | null
  doc_type?: DocType | null
  doc_id?: number | null
  doc_line_id?: number | null
  /** Bắt buộc với ADJUST_IN / ADJUST_OUT / DAMAGE / WRITE_OFF (xem reasons.ts). */
  reason_code?: string | null
  note?: string | null
  /** Người thực hiện; chế độ standalone 1 người ghi 'local'. */
  actor?: string | null
  /** Bắt buộc với REVERSAL: id của movement bị đảo. */
  reverses_movement_id?: number | null
  /**
   * GĐ1 (hàng mua qua PO): RECEIVE/RETURN_IN với cờ này vào thẳng xô inspect
   * (on_hand += qty VÀ inspect += qty) — hàng chờ QC, chưa khả dụng.
   * Không có cờ: RECEIVE như cũ, vào thẳng khả dụng (nhập tay GĐ0).
   */
  into_inspect?: boolean
  /**
   * GĐ1: DAMAGE với cờ này lấy phần hỏng TỪ xô inspect (inspect -= qty,
   * damaged += qty) — hàng hỏng phát hiện khi QC, chưa từng khả dụng.
   * Không có cờ: DAMAGE như cũ, trừ vào phần khả dụng.
   */
  from_inspect?: boolean
  /** Kỳ nạp file (sources.period) tại thời điểm biến động, nếu liên quan. */
  period?: number | null
  created_at?: string | null
}

/** Các loại biến động bắt buộc có reason_code. */
export const REASON_REQUIRED: ReadonlySet<MovementType> = new Set([
  'ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'WRITE_OFF',
])
