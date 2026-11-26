import { useMemo, useState } from 'react'
import {
  ackAlert, applyCycleCount, approveCycleCount, createCycleCount, createDraftPosFromSuggestions,
  createTransferOrder, freezeStock, getCycleCount, getReplenishment, getTransferOrder,
  listAlerts, listBalanceDetails, listCycleCounts, listFrozen, listPolicies,
  listProductsWithSupplier, listTransferOrders, moveStock, receiveTransferOrder,
  rejectCycleCount, scanAndStoreAlerts, setDefaultSupplier, shipTransferOrder,
  submitCountEntries, unfreezeStock, upsertPolicy, cancelTransferOrder,
  type BalanceDetail, type FrozenRow,
} from '../../shared/inventory/ops.ts'
import {
  listLocations, listSuppliers, listWarehouses, listZones,
  type LocationRow,
} from '../../shared/inventory/purchase.ts'
import { ADJUSTMENT_REASONS } from '../../domain/ledger/reasons.ts'
import { COUNT_STATUS_LABELS } from '../../domain/ops/cycle-count.ts'
import { TRANSFER_STATUS_LABELS } from '../../domain/ops/transfer.ts'
import { ALERT_TYPE_LABELS, type AlertType } from '../../domain/ops/alerts.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const numOf = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(',', '.')))
const fmt = (n: number | null | undefined) => (n == null ? '—' : String(n))

type Tab = 'count' | 'freeze' | 'transfer' | 'replenish' | 'alerts'
const TABS: { id: Tab; label: string }[] = [
  { id: 'count', label: 'Kiểm kê quay vòng' },
  { id: 'freeze', label: 'Đóng băng' },
  { id: 'transfer', label: 'Chuyển kho' },
  { id: 'replenish', label: 'Gợi ý đặt hàng' },
  { id: 'alerts', label: 'Cảnh báo' },
]

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('count')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Vận hành kho">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`min-h-11 rounded-lg px-4 font-medium ${tab === t.id ? 'bg-brand-600 text-white' : 'border border-slate-300 bg-white'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <Notice>
        Vận hành ở đây chỉ áp cho hàng theo lô của sổ cái (hàng nhận qua PO). Phiếu kiểm mù
        cũ cho hàng nạp file vẫn ở mục Kiểm kho, không đổi. Mọi thay đổi tồn đều ghi sổ cái
        kèm lý do; chênh lệch kiểm kê chỉ vào tồn sau khi được duyệt.
      </Notice>
      {tab === 'count' && <CountTab />}
      {tab === 'freeze' && <FreezeTab />}
      {tab === 'transfer' && <TransferTab />}
      {tab === 'replenish' && <ReplenishTab />}
      {tab === 'alerts' && <AlertsTab />}
    </div>
  )
}

const balKey = (b: { warehouse_id: number | null; location_id: number | null; lot_id: number | null; sku: string }) =>
  `${b.warehouse_id ?? ''}|${b.location_id ?? ''}|${b.lot_id ?? ''}|${b.sku.toUpperCase()}`

// ================= Tab Kiểm kê quay vòng =================
function CountTab() {
  const counts = useLoad(() => listCycleCounts(), [])
  const locations = useLoad(() => listLocations(), [])
  const zones = useLoad(() => listZones(), [])
  const [scopeType, setScopeType] = useState<'LOCATION' | 'ZONE' | 'SKU'>('LOCATION')
  const [scopeLocation, setScopeLocation] = useState('')
  const [scopeZone, setScopeZone] = useState('')
  const [scopeSku, setScopeSku] = useState('')
  const [blind, setBlind] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true); setError('')
    try {
      const { id, count_no, task_count } = await createCycleCount({
        type: scopeType,
        location_id: scopeType === 'LOCATION' ? Number(scopeLocation) || null : null,
        zone_id: scopeType === 'ZONE' ? Number(scopeZone) || null : null,
        sku: scopeType === 'SKU' ? scopeSku.trim() : null,
        blind,
      })
      counts.reload()
      setSelectedId(id)
      alert(`Đã tạo phiên kiểm ${count_no} với ${task_count} dòng`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="font-semibold">Tạo phiên kiểm kê quay vòng</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Phạm vi">
            <select className={inputClass} value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)}>
              <option value="LOCATION">Theo vị trí</option>
              <option value="ZONE">Theo khu</option>
              <option value="SKU">Theo SKU</option>
            </select>
          </Field>
          {scopeType === 'LOCATION' && (
            <Field label="Vị trí">
              <select className={inputClass} value={scopeLocation} onChange={(e) => setScopeLocation(e.target.value)}>
                <option value="">— Chọn vị trí —</option>
                {(locations.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
              </select>
            </Field>
          )}
          {scopeType === 'ZONE' && (
            <Field label="Khu">
              <select className={inputClass} value={scopeZone} onChange={(e) => setScopeZone(e.target.value)}>
                <option value="">— Chọn khu —</option>
                {(zones.data ?? []).map((z) => <option key={z.id} value={z.id}>{z.code} — {z.name}</option>)}
              </select>
            </Field>
          )}
          {scopeType === 'SKU' && (
            <Field label="SKU">
              <input className={inputClass} value={scopeSku} onChange={(e) => setScopeSku(e.target.value)} placeholder="VD: GD1-1" />
            </Field>
          )}
          <Field label="Chế độ mù (ẩn số sổ sách khi đếm)">
            <select className={inputClass} value={blind ? '1' : '0'} onChange={(e) => setBlind(e.target.value === '1')}>
              <option value="0">Hiện số sổ sách</option>
              <option value="1">Mù — chỉ nhập số đếm</option>
            </select>
          </Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <Button kind="primary" disabled={busy} onClick={create}>Tạo phiên kiểm</Button>
      </Card>

      <Card className="space-y-2">
        <h2 className="font-semibold">Các phiên kiểm kê</h2>
        {(counts.data ?? []).length === 0 && <p className="text-slate-600">Chưa có phiên nào.</p>}
        <ul className="divide-y divide-slate-100">
          {(counts.data ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
              <button className="font-medium text-brand-700 underline" onClick={() => setSelectedId(c.id)}>{c.count_no}</button>
              <span>{c.scope_type === 'LOCATION' ? 'Theo vị trí' : c.scope_type === 'ZONE' ? 'Theo khu' : 'Theo SKU'} {c.scope_sku}</span>
              {c.blind === 1 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-sm">Mù</span>}
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-sm font-medium text-brand-900">
                {COUNT_STATUS_LABELS[c.status] ?? c.status}
              </span>
              <span className="text-sm text-slate-500">{c.created_at}</span>
            </li>
          ))}
        </ul>
      </Card>

      {selectedId != null && (
        <CountDetail key={selectedId} id={selectedId} onChanged={() => counts.reload()} />
      )}
    </div>
  )
}

function CountDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const detail = useLoad(() => getCycleCount(id), [id])
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const data = detail.data
  const blind = data?.count.blind === 1 && (data?.count.status === 'OPEN')

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true); setError('')
    try {
      await fn()
      detail.reload(); onChanged()
      if (done) alert(done)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  if (detail.loading) return <p className="text-slate-600">Đang tải…</p>
  if (!data) return <Notice kind="error">Không tìm thấy phiên kiểm kê.</Notice>
  const { count, tasks } = data
  const editable = count.status === 'OPEN' || count.status === 'COUNTED'

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Phiên {count.count_no} — {COUNT_STATUS_LABELS[count.status] ?? count.status}</h2>
      {count.approved_by && <p className="text-sm text-slate-600">Duyệt bởi {count.approved_by} lúc {count.approved_at}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-base">
          <thead>
            <tr className="border-b border-slate-200 text-sm text-slate-600">
              <th className="py-2 pr-3">SKU</th><th className="py-2 pr-3">Vị trí</th><th className="py-2 pr-3">Lô</th>
              {!blind && <th className="py-2 pr-3">Sổ sách (on hand)</th>}
              <th className="py-2 pr-3">Đang băng / chờ QC</th>
              <th className="py-2 pr-3">Số đếm</th>
              {!blind && <th className="py-2 pr-3">Chênh lệch</th>}
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const counted = inputs[t.id] ?? (t.counted_qty == null ? '' : String(t.counted_qty))
              const variance = counted.trim() === '' || blind ? null : numOf(counted) - t.expected_qty
              return (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium">{t.sku}</td>
                  <td className="py-2 pr-3">{t.location_code || t.location_id}</td>
                  <td className="py-2 pr-3">{t.lot_id ?? '—'}</td>
                  {!blind && <td className="py-2 pr-3">{t.expected_qty}</td>}
                  <td className="py-2 pr-3">{t.hold_qty} / {t.inspect_qty}</td>
                  <td className="py-2 pr-3">
                    <input className={`${inputClass} w-28`} inputMode="decimal" disabled={!editable}
                      value={counted} onChange={(e) => setInputs((s) => ({ ...s, [t.id]: e.target.value }))}
                      placeholder="Nhập số đếm" aria-label={`Số đếm ${t.sku}`} />
                  </td>
                  {!blind && (
                    <td className={`py-2 pr-3 font-medium ${variance != null && variance !== 0 ? 'text-red-700' : ''}`}>
                      {variance == null || Number.isNaN(variance) ? '—' : variance > 0 ? `+${variance}` : variance}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {blind && <Notice kind="warn">Phiên mù: số sổ sách và chênh lệch chỉ hiện sau khi đếm xong toàn bộ.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button kind="primary" disabled={busy} onClick={() => run(async () => {
            const entries = tasks
              .filter((t) => (inputs[t.id] ?? '').trim() !== '')
              .map((t) => ({ task_id: t.id, counted_qty: numOf(inputs[t.id]) }))
            if (!entries.length) throw new Error('Chưa nhập số đếm cho dòng nào')
            await submitCountEntries(id, entries)
          }, 'Đã lưu số đếm')}>Lưu số đếm</Button>
        )}
        {count.status === 'COUNTED' && (
          <>
            <Button kind="primary" disabled={busy} onClick={() => run(async () => {
              await approveCycleCount(id)
              const r = await applyCycleCount(id)
              return r
            }, 'Đã duyệt và áp chênh lệch vào tồn')}>Duyệt &amp; áp vào tồn</Button>
            <Button kind="danger" disabled={busy} onClick={() => run(() => rejectCycleCount(id), 'Đã từ chối phiên — cần đếm lại')}>Từ chối</Button>
          </>
        )}
      </div>
    </Card>
  )
}

// ================= Tab Đóng băng =================
function FreezeTab() {
  const balances = useLoad(() => listBalanceDetails(), [])
  const frozen = useLoad(() => listFrozen(), [])
  const [selected, setSelected] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('QUALITY_HOLD')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const rows = useMemo(
    () => (balances.data ?? []).filter((b) => b.on_hand > 0 || b.hold > 0),
    [balances.data],
  )
  const current: BalanceDetail | undefined = rows.find((b) => balKey(b) === selected)

  async function doFreeze() {
    if (!current) return
    setBusy(true); setError('')
    try {
      await freezeStock({
        warehouse_id: current.warehouse_id, location_id: current.location_id, lot_id: current.lot_id,
        sku: current.sku, qty: numOf(qty), reason_code: reason,
      })
      setQty(''); balances.reload(); frozen.reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function doUnfreeze(b: FrozenRow, amount: string) {
    setBusy(true); setError('')
    try {
      await unfreezeStock({
        warehouse_id: b.warehouse_id, location_id: b.location_id, lot_id: b.lot_id,
        sku: b.sku, qty: numOf(amount),
      })
      balances.reload(); frozen.reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="font-semibold">Đóng băng tồn theo lô / vị trí</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Dòng tồn (SKU — vị trí — lô)">
            <select className={inputClass} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— Chọn dòng tồn —</option>
              {rows.map((b) => (
                <option key={balKey(b)} value={balKey(b)}>
                  {b.sku} — {b.location_code || b.location_id} — lô {b.lot_id ?? '—'} (khả dụng {b.available})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Số lượng đóng băng">
            <input className={inputClass} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="Lý do (bắt buộc)">
            <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
              {ADJUSTMENT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </Field>
        </div>
        {current && <p className="text-slate-600">Khả dụng hiện tại: {current.available} / tồn vật lý {current.on_hand} (đang băng {current.hold})</p>}
        {error && <Notice kind="error">{error}</Notice>}
        <Button kind="primary" disabled={busy || !current} onClick={doFreeze}>Đóng băng</Button>
      </Card>

      <Card className="space-y-2">
        <h2 className="font-semibold">Đang đóng băng</h2>
        {(frozen.data ?? []).length === 0 && <p className="text-slate-600">Không có dòng nào đang bị đóng băng.</p>}
        <ul className="divide-y divide-slate-100">
          {(frozen.data ?? []).map((b) => (
            <FrozenItem key={balKey(b)} b={b} busy={busy} onUnfreeze={doUnfreeze} />
          ))}
        </ul>
      </Card>
    </div>
  )
}

function FrozenItem({ b, busy, onUnfreeze }: {
  b: FrozenRow
  busy: boolean
  onUnfreeze: (b: FrozenRow, amount: string) => void
}) {
  const [amount, setAmount] = useState('')
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <span className="font-medium">{b.sku}</span>
      <span>{b.location_code || b.location_id} — lô {b.lot_id ?? '—'}</span>
      <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-sm font-medium text-sky-900">Đang băng {b.hold}</span>
      <span className="text-sm text-slate-600">{b.reason_code} · {b.frozen_by} · {b.frozen_at}</span>
      <input className={`${inputClass} w-24`} inputMode="decimal" placeholder="SL mở" value={amount}
        onChange={(e) => setAmount(e.target.value)} aria-label={`Số lượng mở băng ${b.sku}`} />
      <Button disabled={busy} onClick={() => onUnfreeze(b, amount)}>Mở băng</Button>
    </li>
  )
}

// ================= Tab Chuyển kho =================
function TransferTab() {
  const warehouses = useLoad(() => listWarehouses(), [])
  const locations = useLoad(() => listLocations(), [])
  const balances = useLoad(() => listBalanceDetails(), [])
  const orders = useLoad(() => listTransferOrders(), [])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Move nhanh
  const [moveKey, setMoveKey] = useState('')
  const [moveTo, setMoveTo] = useState('')
  const [moveQty, setMoveQty] = useState('')
  const movableRows = useMemo(() => (balances.data ?? []).filter((b) => b.available > 0), [balances.data])
  const moveSource = movableRows.find((b) => balKey(b) === moveKey)

  async function doMove() {
    if (!moveSource) return
    setBusy(true); setError('')
    try {
      await moveStock({
        warehouse_id: moveSource.warehouse_id, location_id: moveSource.location_id!, lot_id: moveSource.lot_id,
        sku: moveSource.sku, qty: numOf(moveQty), to_location_id: Number(moveTo),
      })
      setMoveQty(''); balances.reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  // Phiếu chuyển kho
  const [fromWh, setFromWh] = useState('')
  const [toWh, setToWh] = useState('')
  const [tSku, setTSku] = useState('')
  const [tLot, setTLot] = useState('')
  const [tFromLoc, setTFromLoc] = useState('')
  const [tToLoc, setTToLoc] = useState('')
  const [tQty, setTQty] = useState('')
  const fromLocs = (locations.data ?? []).filter((l: LocationRow) => String(l.warehouse_id) === fromWh)
  const toLocs = (locations.data ?? []).filter((l: LocationRow) => String(l.warehouse_id) === toWh)

  async function doCreate() {
    setBusy(true); setError('')
    try {
      const { id, transfer_no } = await createTransferOrder({
        from_warehouse_id: Number(fromWh), to_warehouse_id: Number(toWh),
        lines: [{
          sku: tSku.trim(), lot_id: tLot.trim() === '' ? null : Number(tLot),
          from_location_id: Number(tFromLoc), to_location_id: Number(tToLoc), qty: numOf(tQty),
        }],
      })
      orders.reload(); setSelectedId(id)
      alert(`Đã tạo phiếu chuyển ${transfer_no}`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="font-semibold">Chuyển vị trí nhanh (trong cùng kho, qua movement MOVE)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Dòng tồn nguồn">
            <select className={inputClass} value={moveKey} onChange={(e) => setMoveKey(e.target.value)}>
              <option value="">— Chọn dòng tồn —</option>
              {movableRows.map((b) => (
                <option key={balKey(b)} value={balKey(b)}>
                  {b.sku} — {b.location_code || b.location_id} — lô {b.lot_id ?? '—'} (di chuyển được {b.available})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vị trí đích">
            <select className={inputClass} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">— Chọn vị trí —</option>
              {(locations.data ?? [])
                .filter((l) => !moveSource || l.id !== moveSource.location_id)
                .map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
            </select>
          </Field>
          <Field label="Số lượng">
            <input className={inputClass} inputMode="decimal" value={moveQty} onChange={(e) => setMoveQty(e.target.value)} />
          </Field>
        </div>
        <Button kind="primary" disabled={busy || !moveSource || !moveTo} onClick={doMove}>Chuyển vị trí</Button>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Tạo phiếu chuyển kho (2 bước: xuất kho nguồn → nhận kho đích)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Kho nguồn">
            <select className={inputClass} value={fromWh} onChange={(e) => setFromWh(e.target.value)}>
              <option value="">— Chọn kho —</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
          </Field>
          <Field label="Kho đích">
            <select className={inputClass} value={toWh} onChange={(e) => setToWh(e.target.value)}>
              <option value="">— Chọn kho —</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
          </Field>
          <Field label="SKU">
            <input className={inputClass} value={tSku} onChange={(e) => setTSku(e.target.value)} />
          </Field>
          <Field label="Lot ID (để trống nếu không theo lô)">
            <input className={inputClass} inputMode="numeric" value={tLot} onChange={(e) => setTLot(e.target.value)} />
          </Field>
          <Field label="Vị trí nguồn">
            <select className={inputClass} value={tFromLoc} onChange={(e) => setTFromLoc(e.target.value)}>
              <option value="">— Chọn vị trí —</option>
              {fromLocs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
            </select>
          </Field>
          <Field label="Vị trí đích">
            <select className={inputClass} value={tToLoc} onChange={(e) => setTToLoc(e.target.value)}>
              <option value="">— Chọn vị trí —</option>
              {toLocs.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
            </select>
          </Field>
          <Field label="Số lượng">
            <input className={inputClass} inputMode="decimal" value={tQty} onChange={(e) => setTQty(e.target.value)} />
          </Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <Button kind="primary" disabled={busy || !fromWh || !toWh} onClick={doCreate}>Tạo phiếu chuyển</Button>
      </Card>

      <Card className="space-y-2">
        <h2 className="font-semibold">Phiếu chuyển kho</h2>
        {(orders.data ?? []).length === 0 && <p className="text-slate-600">Chưa có phiếu nào.</p>}
        <ul className="divide-y divide-slate-100">
          {(orders.data ?? []).map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 py-2">
              <button className="font-medium text-brand-700 underline" onClick={() => setSelectedId(o.id)}>{o.transfer_no}</button>
              <span>Kho {o.from_warehouse_id} → Kho {o.to_warehouse_id}</span>
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-sm font-medium text-brand-900">
                {TRANSFER_STATUS_LABELS[o.status] ?? o.status}
              </span>
              <span className="text-sm text-slate-500">{o.created_at}</span>
            </li>
          ))}
        </ul>
      </Card>

      {selectedId != null && (
        <TransferDetail key={selectedId} id={selectedId} onChanged={() => { orders.reload(); balances.reload() }} />
      )}
    </div>
  )
}

function TransferDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const detail = useLoad(() => getTransferOrder(id), [id])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError('')
    try { await fn(); detail.reload(); onChanged(); alert(done) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (detail.loading) return <p className="text-slate-600">Đang tải…</p>
  if (!detail.data) return <Notice kind="error">Không tìm thấy phiếu chuyển.</Notice>
  const { order, lines } = detail.data
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Phiếu {order.transfer_no} — {TRANSFER_STATUS_LABELS[order.status] ?? order.status}</h2>
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l.id}>{l.sku} — lô {l.lot_id ?? '—'} — vị trí {l.from_location_id} → {l.to_location_id} — SL {l.qty}</li>
        ))}
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        {order.status === 'DRAFT' && (
          <>
            <Button kind="primary" disabled={busy} onClick={() => run(() => shipTransferOrder(id), 'Đã xuất kho nguồn — hàng đang trên đường (in-transit)')}>
              Xác nhận xuất kho nguồn
            </Button>
            <Button kind="danger" disabled={busy} onClick={() => run(() => cancelTransferOrder(id), 'Đã huỷ phiếu chuyển')}>Huỷ phiếu</Button>
          </>
        )}
        {order.status === 'IN_TRANSIT' && (
          <Button kind="primary" disabled={busy} onClick={() => run(() => receiveTransferOrder(id), 'Đã nhận vào kho đích')}>
            Xác nhận nhận kho đích
          </Button>
        )}
      </div>
    </Card>
  )
}

// ================= Tab Gợi ý đặt hàng =================
function ReplenishTab() {
  const policies = useLoad(() => listPolicies(), [])
  const products = useLoad(() => listProductsWithSupplier(), [])
  const suppliers = useLoad(() => listSuppliers(), [])
  const data = useLoad(() => getReplenishment(), [])
  const [sku, setSku] = useState('')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [point, setPoint] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function savePolicy() {
    setBusy(true); setError('')
    try {
      await upsertPolicy({
        sku: sku.trim(),
        min_qty: min.trim() === '' ? null : numOf(min),
        max_qty: max.trim() === '' ? null : numOf(max),
        reorder_point: point.trim() === '' ? null : numOf(point),
      })
      policies.reload(); data.reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function createPos() {
    setBusy(true); setError('')
    try {
      const r = await createDraftPosFromSuggestions()
      data.reload()
      alert(r.created.length
        ? `Đã tạo PO nháp: ${r.created.map((c) => `${c.po_no} (${c.supplier_name}, ${c.line_count} dòng)`).join('; ')}`
        : 'Chưa tạo được PO nào (kiểm tra nhóm Chưa rõ NCC bên dưới)')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="font-semibold">Chính sách tồn min / max theo SKU</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="SKU">
            <input className={inputClass} value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Field label="Min (mức tối thiểu)">
            <input className={inputClass} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="Max (mức tối đa)">
            <input className={inputClass} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
          <Field label="Điểm đặt lại (reorder point, tuỳ chọn)">
            <input className={inputClass} inputMode="decimal" value={point} onChange={(e) => setPoint(e.target.value)} />
          </Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <Button kind="primary" disabled={busy || !sku.trim()} onClick={savePolicy}>Lưu chính sách</Button>
        <ul className="divide-y divide-slate-100">
          {(policies.data ?? []).map((p) => (
            <li key={p.id} className="py-1.5">
              <span className="font-medium">{p.sku}</span> — min {fmt(p.min_qty)} · max {fmt(p.max_qty)} · điểm đặt lại {fmt(p.reorder_point)}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Gán nhà cung cấp mặc định cho SKU</h2>
        <ul className="divide-y divide-slate-100">
          {(products.data ?? []).map((p) => (
            <li key={p.sku} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{p.sku}</span>
              <span className="text-slate-600">{p.name}</span>
              <select className={`${inputClass} w-auto`} aria-label={`NCC mặc định của ${p.sku}`}
                value={p.default_supplier_id ?? ''}
                onChange={async (e) => {
                  await setDefaultSupplier(p.sku, e.target.value === '' ? null : Number(e.target.value))
                  products.reload(); data.reload()
                }}>
                <option value="">— Chưa gán —</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Gợi ý đặt hàng (gom theo nhà cung cấp)</h2>
        {(data.data?.groups ?? []).length === 0 && <p className="text-slate-600">Chưa có SKU nào chạm ngưỡng đặt lại.</p>}
        {(data.data?.groups ?? []).map((g) => (
          <div key={g.supplier_id ?? 'none'} className="space-y-1">
            <h3 className="font-medium">{g.supplier_name}</h3>
            {g.supplier_id == null && (
              <Notice kind="warn">Nhóm này chưa gán NCC mặc định nên không tạo PO nháp được — hãy gán NCC ở bảng trên.</Notice>
            )}
            <ul className="space-y-1">
              {g.lines.map((l) => (
                <li key={`${l.warehouse_id}-${l.sku}`}>
                  {l.sku} — khả dụng {l.available}, đang đặt {l.on_order} → gợi ý đặt <strong>{l.suggested_qty}</strong>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <Button kind="primary" disabled={busy} onClick={createPos}>Tạo PO nháp từ gợi ý</Button>
      </Card>
    </div>
  )
}

// ================= Tab Cảnh báo =================
const SEV_STYLE: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-900',
  WARN: 'bg-amber-100 text-amber-900',
  INFO: 'bg-sky-100 text-sky-900',
}

function AlertsTab() {
  const alerts = useLoad(() => listAlerts(), [])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const rows = (alerts.data ?? []).filter((a) => !filter || a.status === filter)

  async function scan() {
    setBusy(true); setError('')
    try {
      const r = await scanAndStoreAlerts()
      alerts.reload()
      alert(`Quét xong: ${r.found} cảnh báo đang có điều kiện, ${r.resolved} cảnh báo tự hết (RESOLVED)`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" disabled={busy} onClick={scan}>Quét cảnh báo</Button>
        <select className={`${inputClass} w-auto`} aria-label="Lọc trạng thái cảnh báo" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          <option value="NEW">Mới</option>
          <option value="ACK">Đã xác nhận</option>
          <option value="RESOLVED">Đã hết (tự đóng)</option>
        </select>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Card className="space-y-2">
        {rows.length === 0 && <p className="text-slate-600">Chưa có cảnh báo nào. Bấm “Quét cảnh báo” để quét từ dữ liệu lô/tồn hiện tại.</p>}
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className={`rounded-full px-2.5 py-0.5 text-sm font-medium ${SEV_STYLE[a.severity] ?? ''}`}>{a.severity}</span>
              <span className="font-medium">{ALERT_TYPE_LABELS[a.type as AlertType] ?? a.type}</span>
              <span className="flex-1">{a.message}</span>
              <span className="text-sm text-slate-500">{a.status}{a.ack_by ? ` · ${a.ack_by}` : ''}</span>
              {a.status === 'NEW' && (
                <Button disabled={busy} onClick={async () => { await ackAlert(a.id); alerts.reload() }}>Đã biết</Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
