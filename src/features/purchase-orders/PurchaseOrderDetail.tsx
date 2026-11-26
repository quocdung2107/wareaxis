import { useCallback, useEffect, useState } from 'react'
import {
  getPurchaseOrder, getReceipt, listReceipts, transitionPurchaseOrder,
  type PoLine, type PurchaseOrder, type Receipt, type ReceiptLine,
} from '../../shared/inventory/purchase.ts'
import { MANUAL_TRANSITIONS, isReceivable, type PoStatus } from '../../domain/inbound/purchase-order.ts'
import { Button, Card, Notice } from '../../shared/ui/ui.tsx'
import { PoStatusBadge } from './PurchaseOrdersPage.tsx'
import ReceiveDialog from './ReceiveDialog.tsx'
import QcPutawayPanel from './QcPutawayPanel.tsx'

export default function PurchaseOrderDetail({ poId, onBack }: { poId: number; onBack: () => void }) {
  const [order, setOrder] = useState<PurchaseOrder | null>(null)
  const [lines, setLines] = useState<PoLine[]>([])
  const [receipts, setReceipts] = useState<{ receipt: Receipt; lines: ReceiptLine[] }[]>([])
  const [error, setError] = useState('')
  const [showReceive, setShowReceive] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const got = await getPurchaseOrder(poId)
      if (!got) { setError('Không tìm thấy đơn mua'); return }
      setOrder(got.order)
      setLines(got.lines)
      const rs = await listReceipts(poId)
      const full = []
      for (const r of rs) {
        const g = await getReceipt(r.id)
        if (g) full.push(g)
      }
      setReceipts(full)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [poId])

  useEffect(() => { void reload() }, [reload])

  async function transition(to: PoStatus) {
    setBusy(true); setError('')
    try {
      await transitionPurchaseOrder(poId, to)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  if (!order) return <div className="space-y-3"><Button onClick={onBack}>← Quay lại</Button>{error && <Notice kind="error">{error}</Notice>}</div>

  const manual = MANUAL_TRANSITIONS[order.status] ?? []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onBack}>← Danh sách</Button>
        <h2 className="text-xl font-semibold">{order.po_no}</h2>
        <PoStatusBadge status={order.status} />
      </div>
      {error && <Notice kind="error">{error}</Notice>}

      <Card className="space-y-1">
        <p>Nhà cung cấp: <b>{order.supplier_name || '—'}</b></p>
        <p>Ngày giao dự kiến: {order.expected_date || '—'} · Tổng tiền: {order.total_amount.toLocaleString('vi-VN')} đ</p>
        <p>Tạo bởi {order.created_by} lúc {order.created_at}{order.note ? ` · ${order.note}` : ''}</p>
        <div className="flex flex-wrap gap-3 pt-2">
          {manual.map((to) => (
            <Button key={to} kind={to === 'CANCELLED' ? 'danger' : 'primary'} disabled={busy} onClick={() => transition(to)}>
              {to === 'SENT' ? 'Gửi cho NCC' : to === 'CANCELLED' ? 'Huỷ đơn' : 'Đóng đơn'}
            </Button>
          ))}
          {isReceivable(order.status) && (
            <Button kind="primary" onClick={() => setShowReceive((s) => !s)}>Nhận hàng</Button>
          )}
        </div>
      </Card>

      <Card className="space-y-2">
        <h3 className="font-semibold">Dòng hàng</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="text-slate-600">
                <th className="py-1 pr-3">SKU</th><th className="py-1 pr-3">Mô tả</th>
                <th className="py-1 pr-3">Đặt</th><th className="py-1 pr-3">Đã nhận</th>
                <th className="py-1 pr-3">Hỏng</th><th className="py-1">Giá dự kiến</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-medium">{l.sku}</td>
                  <td className="py-1 pr-3">{l.description}</td>
                  <td className="py-1 pr-3">{l.qty_ordered}</td>
                  <td className="py-1 pr-3">{l.qty_received}</td>
                  <td className="py-1 pr-3">{l.qty_damaged}</td>
                  <td className="py-1">{l.unit_price?.toLocaleString('vi-VN') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {showReceive && isReceivable(order.status) && (
        <ReceiveDialog poId={poId} poStatus={order.status} lines={lines} onDone={() => { setShowReceive(false); void reload() }} />
      )}

      {receipts.map((r) => (
        <QcPutawayPanel key={r.receipt.id} receipt={r.receipt} lines={r.lines} onChanged={() => void reload()} />
      ))}
      {receipts.length === 0 && <Notice>Chưa có phiếu nhận nào cho đơn này.</Notice>}
    </div>
  )
}
