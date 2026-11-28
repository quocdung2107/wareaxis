import { useEffect, type ReactNode } from 'react'
import { Button, Notice } from './ui'

/**
 * Dialog chứa FORM dùng chung (declarative) — hợp nhất hai pattern sẵn
 * có của repo: modal của features/data/RowEditDialogs (panel, nền mờ,
 * mobile items-end) và hành vi Esc/click-nền của shared/ui/Dialog.tsx.
 * Component KHÔNG giữ state form: form là `children` do màn hình cha
 * quản, để cùng một dialog phục vụ cả Thêm (form rỗng) và Sửa (form
 * điền sẵn) chỉ bằng cách truyền dữ liệu khởi tạo khác nhau.
 * Khi `busy`, mọi lối đóng (Esc, click nền, nút ✕, nút Huỷ) đều bị khoá
 * để không đóng giữa chừng khi RPC đang chạy.
 */
export interface FormDialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Hàng nút cuối dialog; mặc định [Huỷ] [Lưu] khi có onSubmit. */
  submitText?: string
  onSubmit?: () => void
  busy?: boolean
  /** Lỗi hiển thị ngay trên footer, dialog không đóng khi có lỗi. */
  error?: string
  /** Panel rộng (max-w-2xl) cho form nhiều trường như đăng tải. */
  wide?: boolean
}

export function FormDialog({ title, onClose, children, submitText = 'Lưu', onSubmit, busy = false, error, wide = false }: FormDialogProps) {
  useEffect(() => {
    if (busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90vh] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} space-y-3 overflow-y-auto rounded-t-xl bg-white p-4 shadow-lg sm:rounded-xl`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            aria-label="Đóng"
            disabled={busy}
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-lg disabled:opacity-50"
          >
            ✕
          </button>
        </div>
        {children}
        {error && <Notice kind="error">{error}</Notice>}
        {onSubmit && (
          <div className="flex justify-end gap-2">
            <Button kind="secondary" onClick={onClose} disabled={busy}>
              Huỷ
            </Button>
            <Button kind="primary" onClick={onSubmit} disabled={busy}>
              {busy ? 'Đang lưu…' : submitText}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
