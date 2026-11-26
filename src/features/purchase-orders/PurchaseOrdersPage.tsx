import { useState } from 'react'
import {
  createPurchaseOrder, listPurchaseOrders, listSuppliers, upsertSupplier,
  type PurchaseOrder,
} from '../../shared/inventory/purchase.ts'
import { PO_STATUS_LABELS, type PoStatus } from '../../domain/inbound/purchase-order.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'
import PurchaseOrderDetail from './PurchaseOrderDetail.tsx'

interface LineForm { sku: string; description: string; uom: string; qty: string; price: string }
const blankLine = (): LineForm => ({ sku: '', description: '', uom: '', qty: '', price: '' })

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-800',
  SENT: 'bg-sky-100 text-sky-900',
  PARTIAL: 'bg-amber-100 text-amber-900',
  RECEIVED: 'bg-brand-100 text-brand-900',
  CLOSED: 'bg-slate-200 text-slate-700',
  CANCELLED: 'bg-red-100 text-red-800',
}

export function PoStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-medium ${STATUS_STYLE[status] ?? 'bg-slate-100'}`}>
      {PO_STATUS_LABELS[status as PoStatus] ?? status}
    </span>
  )
}

export default function PurchaseOrdersPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const list = useLoad(() => listPurchaseOrders(statusFilter || undefined), [statusFilter])
  const suppliers = useLoad(listSuppliers, [])
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const [creating, setCreating] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [newSupplier, setNewSupplier] = useState({ code: '', name: '' })
  const [expectedDate, setExpectedDate] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<LineForm[]>([blankLine()])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (selectedId != null) {
    return <PurchaseOrderDetail poId={selectedId} onBack={() => { setSelectedId(null); list.reload() }} />
  }

  const setLine = (i: number, p: Partial<LineForm>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)))

  async function create() {
    setBusy(true); setError('')
    try {
      let supId: number | null = supplierId ? Number(supplierId) : null
      if (!supId && newSupplier.code.trim() && newSupplier.name.trim()) {
        const err = await upsertSupplier({ code: newSupplier.code, name: newSupplier.name })
        if (err) throw new Error(err)
        const all = await listSuppliers()
        supId = all.find((s) => s.code === newSupplier.code.trim().toUpperCase())?.id ?? null
        suppliers.reload()
      }
      const { po_no } = await createPurchaseOrder({
        supplier_id: supId,
        expected_date: expectedDate,
        note,
        lines: lines.map((l) => ({
          sku: l.sku,
          description: l.description,
          uom: l.uom,
          qty_ordered: l.qty.trim() === '' ? NaN : Number(l.qty.replace(',', '.')),
          unit_price: l.price.trim() === '' ? null : Number(l.price.replace(',', '.')),
        })),
      })
      setCreating(false)
      setLines([blankLine()]); setNote(''); setExpectedDate(''); setSupplierId(''); setNewSupplier({ code: '', name: '' })
      list.reload()
      alert(`Đã tạo đơn mua ${po_no}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className={`${inputClass} w-auto`} aria-label="Lọc trạng thái" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(PO_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <Button kind="primary" onClick={() => setCreating((c) => !c)}>Tạo đơn mua</Button>
      </div>

      <Notice>
        Hàng mua qua PO đi vào sổ cái theo lô riêng (nhận → chờ QC → cất lên kệ), tách khỏi
        tồn nạp file ở các trang cũ — hai nguồn tồn không trộn nhau.
      </Notice>

      {creating && (
        <Card className="space-y-3">
          <h2 className="font-semibold">Tạo đơn mua hàng</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nhà cung cấp">
              <select className={inputClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— Chọn NCC (hoặc tạo nhanh bên dưới) —</option>
                {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
              </select>
            </Field>
            <Field label="Ngày giao dự kiến">
              <input className={inputClass} placeholder="YYYY-MM-DD" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </Field>
            <Field label="Mã NCC mới (tạo nhanh)">
              <input className={inputClass} value={newSupplier.code} onChange={(e) => setNewSupplier({ ...newSupplier, code: e.target.value })} />
            </Field>
            <Field label="Tên NCC mới (tạo nhanh)">
              <input className={inputClass} value={newSupplier.name} onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} />
            </Field>
            <Field label="Ghi chú">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-5">
              <Field label="SKU *"><input className={inputClass} value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} /></Field>
              <Field label="Mô tả"><input className={inputClass} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
              <Field label="ĐVT"><input className={inputClass} value={l.uom} onChange={(e) => setLine(i, { uom: e.target.value })} /></Field>
              <Field label="SL đặt *"><input className={inputClass} inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
              <Field label="Giá mua dự kiến"><input className={inputClass} inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></Field>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setLines((ls) => [...ls, blankLine()])}>Thêm dòng</Button>
            <Button kind="primary" onClick={create} disabled={busy}>Lưu đơn mua</Button>
            <Button onClick={() => setCreating(false)}>Đóng</Button>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
        </Card>
      )}

      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.data && list.data.length === 0 && <Notice>Chưa có đơn mua nào.</Notice>}
      <div className="space-y-3">
        {(list.data ?? []).map((po: PurchaseOrder) => (
          <Card key={po.id} className="flex flex-wrap items-center gap-3">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(po.id)}>
              <span className="block text-lg font-semibold">{po.po_no}</span>
              <span className="block text-sm text-slate-600">
                {po.supplier_name || 'Chưa chọn NCC'}
                {po.expected_date ? ` · giao dự kiến ${po.expected_date}` : ''}
                {po.total_amount ? ` · ${po.total_amount.toLocaleString('vi-VN')} đ` : ''}
              </span>
            </button>
            <PoStatusBadge status={po.status} />
          </Card>
        ))}
      </div>
    </div>
  )
}
