import { Notice } from '../../shared/ui/ui'
import { SELF_DECLARED_LABEL } from '../../domain/freight/profile'
import type { AccountProfile } from '../../shared/supabase/freightAccount'

/** Nhãn tự khai cố định — bắt buộc xuất hiện ở mọi màn hình hồ sơ đối tác (Bản A mục 0.2). */
export function SelfDeclaredNote() {
  return <Notice kind="warn">{SELF_DECLARED_LABEL}</Notice>
}

/**
 * Ngữ cảnh trang freight ở R1: tài khoản đang đăng nhập + hồ sơ đăng ký
 * của chính tài khoản đó. KHÔNG còn group ở cổng vào — group chỉ xuất
 * hiện trong dialog tạo tải từ đơn và dialog chia sẻ tải vào group.
 */
export interface FreightCtx {
  me: string
  account: AccountProfile
}

export const numOrNull = (v: string): number | null => {
  const t = v.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export const strOrNull = (v: string): string | null => (v.trim() === '' ? null : v.trim())

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('vi-VN')
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  const dt = new Date(`${d}T00:00:00`)
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('vi-VN')
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${new Intl.NumberFormat('vi-VN').format(n)} đ`
}

/** datetime-local -> ISO; rỗng -> null. */
export const localToIso = (v: string): string | null => (v ? new Date(v).toISOString() : null)

/** ISO -> giá trị cho input datetime-local; rỗng/không hợp lệ -> ''. */
export function isoToLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
