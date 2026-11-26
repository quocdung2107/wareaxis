import { useMemo, useState } from 'react'
import {
  applyPutaway, applyQc, listLocations, type Receipt, type ReceiptLine,
} from '../../shared/inventory/purchase.ts'
import { listBalances } from '../../shared/inventory/ledger.ts'
import { batch, query } from '../../shared/db/client.ts'
import { ADJUSTMENT_REASONS } from '../../domain/ledger/reasons.ts'
import { qtyAwaitingPutaway, qtyPendingQc } from '../../domain/inbound/qc.ts'
import { suggestPutawayLocation } from '../../domain/inbound/putaway.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const numOf = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')))
const asQc = (l: ReceiptLine) => ({
  id: l.id, receipt_id: l.receipt_id, sku: l.sku, lot_id: l.lot_id,
  qty_received: l.qty_received, qty_qc_pass: l.qty_qc_pass, qty_qc_fail: l.qty_qc_fail, qty_putaway: l.qty_putaway,
})

/**
 * Panel QC + cất hàng cho MỘT phiếu nhận: từng dòng nhập đạt/hỏng (hỏng bắt
 * buộc lý do) rồi cất phần đạt lên vị trí — vị trí gợi ý sẵn theo quy tắc
 * domain (cùng SKU trước, PICKABLE trống sau), chọn lại được.
 */
export default function QcPutawayPanel({ receipt, lines, onChanged }: {
  receipt: Receipt
  lines: ReceiptLine[]
  onChanged: () => void
}) {
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

  async function doQc(line: ReceiptLine) {
    const f = qcForms[line.id] ?? { pass: '', fail: '', reason: 'DAMAGED' }
    setBusy(true); setError('')
    try {
      await applyQc(line.id, {
        qty_pass: numOf(f.pass), qty_fail: numOf(f.fail),
        reason_code: numOf(f.fail) > 0 ? f.reason : null,
      })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function doPutaway(line: ReceiptLine) {
    const suggested = suggestPutawayLocation(line.sku, locs, stock)
    const f = putForms[line.id] ?? { qty: '', loc: suggested ? String(suggested.id) : '' }
    setBusy(true); setError('')
    try {
      await applyPutaway(line.id, { qty: numOf(f.qty), to_location_id: Number(f.loc) })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">
        Phiếu nhận {receipt.receipt_no}
        <span className="ml-2 text-sm font-normal text-slate-600">
          {receipt.received_at} · {receipt.status === 'DONE' ? 'đã xử lý xong' : 'đang chờ QC / cất hàng'}
        </span>
      </h3>
      {error && <Notice kind="error">{error}</Notice>}
      {lines.map((l) => {
        const pending = qtyPendingQc(asQc(l))
        const awaiting = qtyAwaitingPutaway(asQc(l))
        const suggested = suggestPutawayLocation(l.sku, locs, stock)
        // Gợi ý mặc định: phần "tốt khi nhận" chưa QC -> đạt, phần "hỏng khi nhận" chưa QC -> hỏng.
        const qf = qcForms[l.id] ?? {
          pass: pending > 0 ? String(Math.max(0, l.qty_good - l.qty_qc_pass)) : '',
          fail: pending > 0 ? String(Math.max(0, l.qty_damaged - l.qty_qc_fail)) : '',
          reason: 'DAMAGED',
        }
        const pf = putForms[l.id] ?? { qty: awaiting > 0 ? String(awaiting) : '', loc: suggested ? String(suggested.id) : '' }
        return (
          <div key={l.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="font-medium">
              {l.sku} <span className="font-normal text-slate-600">
                — nhận {l.qty_received} (tốt {l.qty_good}, hỏng khi nhận {l.qty_damaged})
                {l.qty_shortage > 0 ? ` · thiếu ${l.qty_shortage}` : ''}{l.qty_more > 0 ? ` · thừa ${l.qty_more}` : ''}
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
    </Card>
  )
}
