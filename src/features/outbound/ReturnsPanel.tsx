import { useMemo, useState } from 'react'
import {
  applyReturn, applyReturnPutaway, applyReturnQc, getReturn, getShipment,
  listReturns, listShipments,
  type ReturnDoc, type ReturnLine,
} from '../../shared/inventory/outbound.ts'
import { listLocations } from '../../shared/inventory/purchase.ts'
import { listBalances } from '../../shared/inventory/ledger.ts'
import { batch, query } from '../../shared/db/client.ts'
import { ADJUSTMENT_REASONS } from '../../domain/ledger/reasons.ts'
import { qtyAwaitingPutaway, qtyPendingQc } from '../../domain/inbound/qc.ts'
import { suggestPutawayLocation } from '../../domain/inbound/putaway.ts'
import { RETURN_STATUS_LABELS } from '../../domain/outbound/returns.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const numOf = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')))

/**
 * Tab Trả hàng: tạo phiếu trả từ một phiếu giao (dòng giao kèm lô gốc), hàng
 * về xô chờ QC tại khu nhận, rồi QC + cất lại bằng đúng domain GĐ1
 * (planQc/planPutaway qua domain/outbound/returns).
 */
export default function ReturnsTab() {
  const shipments = useLoad(listShipments, [])
  const returns = useLoad(listReturns, [])
  const [shipmentId, setShipmentId] = useState('')
  const shipDetail = useLoad(() => (shipmentId ? getShipment(Number(shipmentId)) : Promise.resolve(null)), [shipmentId])
  const [retQty, setRetQty] = useState<Record<number, string>>({})
  const [retReason, setRetReason] = useState<Record<number, string>>({})
  const [selectedReturn, setSelectedReturn] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function doCreateReturn() {
    if (!shipDetail.data) return
    const inputs = shipDetail.data.items
      .map((i) => ({ shipment_item_id: i.id, qty: numOf(retQty[i.id] ?? ''), reason: retReason[i.id] ?? '' }))
      .filter((i) => i.qty > 0)
    if (!inputs.length) { setError('Chưa nhập số lượng trả cho dòng nào'); return }
    setBusy(true); setError('')
    try {
      const { return_no } = await applyReturn(Number(shipmentId), inputs)
      setRetQty({}); setRetReason({})
      shipDetail.reload(); returns.reload()
      alert(`Đã tạo phiếu trả ${return_no} — hàng đang chờ QC ở khu nhận.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}
      <Card className="space-y-3">
        <h2 className="font-semibold">Tạo phiếu trả từ phiếu giao</h2>
        <Field label="Phiếu giao">
          <select className={inputClass} value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
            <option value="">— Chọn phiếu giao —</option>
            {(shipments.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.shipment_no} — đơn {s.order_no}{s.carrier_text ? ` · xe ${s.carrier_text}` : ''} ({s.shipped_at})
              </option>
            ))}
          </select>
        </Field>
        {shipDetail.data && shipDetail.data.items.map((i) => {
          const remaining = i.qty - i.qty_returned
          return (
            <div key={i.id} className="grid grid-cols-2 items-end gap-3 rounded-lg border border-slate-200 p-3 lg:grid-cols-4">
              <p className="text-sm">
                <span className="font-medium">{i.sku}</span>
                <span className="text-slate-600"> — lô gốc #{i.lot_id ?? '—'} · đã giao {i.qty} · đã trả {i.qty_returned} · còn trả được {remaining}</span>
              </p>
              <Field label="SL trả lần này">
                <input className={inputClass} inputMode="decimal" value={retQty[i.id] ?? ''}
                  onChange={(e) => setRetQty((s) => ({ ...s, [i.id]: e.target.value }))} />
              </Field>
              <Field label="Lý do trả">
                <input className={inputClass} value={retReason[i.id] ?? ''}
                  onChange={(e) => setRetReason((s) => ({ ...s, [i.id]: e.target.value }))} />
              </Field>
            </div>
          )
        })}
        {shipDetail.data && (
          <Button kind="primary" onClick={doCreateReturn} disabled={busy}>Nhận hàng trả</Button>
        )}
      </Card>

      <div className="space-y-3">
        {(returns.data ?? []).map((r: ReturnDoc) => (
          <Card key={r.id} className="space-y-2">
            <button type="button" className="flex w-full flex-wrap items-center gap-3 text-left"
              onClick={() => setSelectedReturn(selectedReturn === r.id ? null : r.id)}>
              <span className="flex-1">
                <span className="block text-lg font-semibold">{r.return_no}</span>
                <span className="block text-sm text-slate-600">
                  {r.customer_name || 'chưa ghi khách'} · {RETURN_STATUS_LABELS[r.status as keyof typeof RETURN_STATUS_LABELS] ?? r.status} · {r.created_at}
                </span>
              </span>
            </button>
            {selectedReturn === r.id && <ReturnDetail returnId={r.id} onChanged={returns.reload} />}
          </Card>
        ))}
        {(returns.data ?? []).length === 0 && <Notice>Chưa có phiếu trả nào.</Notice>}
      </div>
    </div>
  )
}

function ReturnDetail({ returnId, onChanged }: { returnId: number; onChanged: () => void }) {
  const detail = useLoad(() => getReturn(returnId), [returnId])
  if (detail.loading) return <p className="text-slate-600">Đang tải…</p>
  if (detail.error) return <Notice kind="error">{detail.error}</Notice>
  if (!detail.data) return null
  return (
    <ReturnQcPanel
      lines={detail.data.lines}
      onChanged={() => { detail.reload(); onChanged() }}
    />
  )
}

const asQc = (l: ReturnLine) => ({
  id: l.id, receipt_id: l.return_id, sku: l.sku, lot_id: l.lot_id,
  qty_received: l.qty_returned, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
})

/** Panel QC + cất cho phiếu trả — cùng mẫu QcPutawayPanel của GĐ1. */
function ReturnQcPanel({ lines, onChanged }: { lines: ReturnLine[]; onChanged: () => void }) {
  const locations = useLoad(listLocations, [])
  const balances = useLoad(() => listBalances({ query, batch }), [])
  const [qcForms, setQcForms] = useState<Record<number, { pass: string; fail: string; reason: string }>>({})
  const [putForms, setPutForms] = useState<Record<number, { qty: string; loc: string }>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const stock = useMemo(
    () => (balances.data ?? []).map((b) => ({ location_id: b.location_id, sku: b.sku, on_hand: b.on_hand })),
    [balances.data],
  )
  const locs = locations.data ?? []

  async function doQc(line: ReturnLine) {
    const f = qcForms[line.id] ?? { pass: '', fail: '', reason: 'RETURN_QC' }
    setBusy(true); setError('')
    try {
      await applyReturnQc(line.id, {
        qty_pass: numOf(f.pass), qty_fail: numOf(f.fail),
        reason_code: numOf(f.fail) > 0 ? f.reason : null,
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function doPutaway(line: ReturnLine) {
    const suggested = suggestPutawayLocation(line.sku, locs, stock)
    const f = putForms[line.id] ?? { qty: '', loc: suggested ? String(suggested.id) : '' }
    setBusy(true); setError('')
    try {
      await applyReturnPutaway(line.id, { qty: numOf(f.qty), to_location_id: Number(f.loc) })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3 border-t border-slate-200 pt-3">
      {error && <Notice kind="error">{error}</Notice>}
      {lines.map((l) => {
        const pending = qtyPendingQc(asQc(l))
        const awaiting = qtyAwaitingPutaway(asQc(l))
        const suggested = suggestPutawayLocation(l.sku, locs, stock)
        const qf = qcForms[l.id] ?? {
          pass: pending > 0 ? String(pending) : '', fail: '', reason: 'RETURN_QC',
        }
        const pf = putForms[l.id] ?? { qty: awaiting > 0 ? String(awaiting) : '', loc: suggested ? String(suggested.id) : '' }
        return (
          <div key={l.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="font-medium">
              {l.sku} <span className="font-normal text-slate-600">
                — lô gốc #{l.lot_id ?? '—'} · trả {l.qty_returned}
                {l.reason ? ` · lý do: ${l.reason}` : ''}
                {' '}· QC: {l.qc_status} (đạt {l.qty_qc_pass}, hỏng {l.qty_qc_fail}) · đã cất {l.qty_putaway}
              </span>
            </p>
            {pending > 0 && (
              <div className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4">
                <Field label={`QC đạt (còn chờ ${pending})`}>
                  <input className={inputClass} inputMode="decimal" value={qf.pass}
                    onChange={(e) => setQcForms((s) => ({ ...s, [l.id]: { ...qf, pass: e.target.value } }))} />
                </Field>
                <Field label="QC hỏng">
                  <input className={inputClass} inputMode="decimal" value={qf.fail}
                    onChange={(e) => setQcForms((s) => ({ ...s, [l.id]: { ...qf, fail: e.target.value } }))} />
                </Field>
                <Field label="Lý do hỏng">
                  <select className={inputClass} value={qf.reason}
                    onChange={(e) => setQcForms((s) => ({ ...s, [l.id]: { ...qf, reason: e.target.value } }))}>
                    {ADJUSTMENT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                  </select>
                </Field>
                <Button kind="primary" onClick={() => doQc(l)} disabled={busy}>Ghi QC</Button>
              </div>
            )}
            {awaiting > 0 && (
              <div className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4">
                <Field label={`SL cất (chờ cất ${awaiting})`}>
                  <input className={inputClass} inputMode="decimal" value={pf.qty}
                    onChange={(e) => setPutForms((s) => ({ ...s, [l.id]: { ...pf, qty: e.target.value } }))} />
                </Field>
                <Field label={`Vị trí đích${suggested ? ` (gợi ý: ${suggested.code})` : ''}`}>
                  <select className={inputClass} value={pf.loc}
                    onChange={(e) => setPutForms((s) => ({ ...s, [l.id]: { ...pf, loc: e.target.value } }))}>
                    <option value="">— Chọn vị trí —</option>
                    {locs.filter((x) => x.active !== 0).map((x) => (
                      <option key={x.id} value={x.id}>{x.code} ({x.loc_type})</option>
                    ))}
                  </select>
                </Field>
                <Button kind="primary" onClick={() => doPutaway(l)} disabled={busy}>Cất hàng</Button>
              </div>
            )}
            {pending <= 0 && awaiting <= 0 && <p className="text-sm text-brand-800">✓ Dòng này đã xử lý xong.</p>}
          </div>
        )
      })}
    </div>
  )
}
