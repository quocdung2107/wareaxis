import { useState } from 'react'
import { applyReceiving, type PoLine } from '../../shared/inventory/purchase.ts'
import { planReceiving, type ReceiveLineInput } from '../../domain/inbound/receiving.ts'
import type { PoStatus } from '../../domain/inbound/purchase-order.ts'
import { Button, Card, Field, inputClass, Notice } from '../../shared/ui/ui.tsx'

interface LineForm {
  qty_received: string; qty_damaged: string; batch_no: string
  manuf_date: string; expiry_date: string; purchase_price: string
}
const blank = (): LineForm => ({ qty_received: '', qty_damaged: '', batch_no: '', manuf_date: '', expiry_date: '', purchase_price: '' })
const numOf = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')))

/**
 * Panel nhận hàng theo PO (không phải modal — trang chi tiết PO nhúng trực tiếp):
 * nhập SL thực nhận / hỏng / lô / ngày SX / HSD / giá cho từng dòng, xem trước
 * thiếu-thừa bằng đúng hàm planReceiving của domain rồi mới áp.
 */
export default function ReceiveDialog({
  poId, poStatus, lines, onDone,
}: {
  poId: number
  poStatus: PoStatus
  lines: PoLine[]
  onDone: () => void
}) {
  const [forms, setForms] = useState<Record<number, LineForm>>({})
  const [preview, setPreview] = useState<ReturnType<typeof planReceiving> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const formOf = (id: number): LineForm => forms[id] ?? blank()
  const setForm = (id: number, p: Partial<LineForm>) => {
    setPreview(null); setError('')
    setForms((f) => ({ ...f, [id]: { ...formOf(id), ...p } }))
  }

  const toInputs = (): ReceiveLineInput[] =>
    lines.map((l) => {
      const f = formOf(l.id)
      return {
        po_line_id: l.id,
        qty_received: numOf(f.qty_received),
        qty_damaged: numOf(f.qty_damaged),
        batch_no: f.batch_no,
        manuf_date: f.manuf_date,
        expiry_date: f.expiry_date,
        purchase_price: f.purchase_price.trim() === '' ? null : Number(f.purchase_price.replace(',', '.')),
      }
    })

  function doPreview() {
    const r = planReceiving(
      lines.map((l) => ({ id: l.id, sku: l.sku, qty_ordered: l.qty_ordered, qty_received: l.qty_received })),
      toInputs(),
      { po_id: poId, po_status: poStatus, warehouse_id: null, receiving_location_id: 0, actor: 'local' },
    )
    if (!r.ok) { setPreview(null); setError(r.error) } else { setError(''); setPreview(r) }
  }

  async function save() {
    setBusy(true); setError('')
    try {
      const { receipt_no } = await applyReceiving(poId, toInputs())
      alert(`Đã ghi phiếu nhận ${receipt_no}. Hàng đang ở khu nhận, chờ QC.`)
      setForms({})
      setPreview(null)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">Nhận hàng theo đơn này</h3>
      {lines.map((l) => {
        const f = formOf(l.id)
        const remaining = Math.max(0, l.qty_ordered - l.qty_received)
        return (
          <div key={l.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="font-medium">
              {l.sku} <span className="font-normal text-slate-600">
                — đặt {l.qty_ordered}, đã nhận {l.qty_received}, còn phải nhận {remaining}
                {l.description ? ` · ${l.description}` : ''}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <Field label="SL thực nhận"><input className={inputClass} inputMode="decimal" value={f.qty_received} onChange={(e) => setForm(l.id, { qty_received: e.target.value })} /></Field>
              <Field label="SL hỏng"><input className={inputClass} inputMode="decimal" value={f.qty_damaged} onChange={(e) => setForm(l.id, { qty_damaged: e.target.value })} /></Field>
              <Field label="Số lô / Batch"><input className={inputClass} value={f.batch_no} onChange={(e) => setForm(l.id, { batch_no: e.target.value })} /></Field>
              <Field label="Ngày SX"><input className={inputClass} placeholder="YYYY-MM-DD" value={f.manuf_date} onChange={(e) => setForm(l.id, { manuf_date: e.target.value })} /></Field>
              <Field label="Hạn dùng"><input className={inputClass} placeholder="YYYY-MM-DD" value={f.expiry_date} onChange={(e) => setForm(l.id, { expiry_date: e.target.value })} /></Field>
              <Field label="Giá nhập"><input className={inputClass} inputMode="decimal" value={f.purchase_price} onChange={(e) => setForm(l.id, { purchase_price: e.target.value })} /></Field>
            </div>
          </div>
        )
      })}
      {error && <Notice kind="error">{error}</Notice>}
      {preview?.ok && (
        <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-semibold">Xem trước phiếu nhận:</p>
          {preview.plan.lines.map((l) => (
            <p key={l.po_line_id}>
              {l.sku}: nhận {l.qty_received} (tốt {l.qty_good}, hỏng {l.qty_damaged})
              {l.qty_shortage > 0 ? ` · còn thiếu ${l.qty_shortage}` : ''}
              {l.qty_more > 0 ? ` · thừa ${l.qty_more}` : ''}
              {' '}· sinh 1 lô mới vào khu nhận (chờ QC)
            </p>
          ))}
          <p>Sau khi lưu, trạng thái đơn: <b>{preview.plan.next_po_status === 'RECEIVED' ? 'Đã nhận đủ' : 'Đã nhận một phần'}</b></p>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={doPreview} disabled={busy}>Xem trước</Button>
        <Button kind="primary" onClick={save} disabled={busy || !preview?.ok}>Lưu phiếu nhận</Button>
      </div>
    </Card>
  )
}
