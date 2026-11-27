import { Notice } from '../../shared/ui/ui'
import { SELF_DECLARED_LABEL } from '../../domain/freight/profile'

/** Nhãn tự khai cố định — bắt buộc xuất hiện ở mọi màn hình hồ sơ đối tác (Bản A mục 0.2). */
export function SelfDeclaredNote() {
  return <Notice kind="warn">{SELF_DECLARED_LABEL}</Notice>
}

export interface FreightCtx {
  groupId: string
  groupName: string
  me: string
  roles: string[]
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
