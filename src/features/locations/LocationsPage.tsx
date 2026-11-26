import { useState } from 'react'
import {
  createLocation, listLocations, listWarehouses, listZones, updateLocation,
  type LocationRow,
} from '../../shared/inventory/purchase.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const LOC_TYPES = ['RECEIVING', 'PICKABLE', 'PICKABLE_STAGING', 'BULK', 'DAMAGE', 'HOLD'] as const
const TYPE_LABELS: Record<string, string> = {
  RECEIVING: 'Khu nhận (không lấy hàng)',
  PICKABLE: 'Lấy hàng được',
  PICKABLE_STAGING: 'Tạm — lấy được',
  BULK: 'Hàng khối / dự trữ',
  DAMAGE: 'Hàng hỏng',
  HOLD: 'Giữ / đóng băng',
}

/** Quản lý kho & vị trí ở mức tối thiểu: danh sách + thêm vị trí + bật/tắt. */
export default function LocationsPage() {
  const warehouses = useLoad(listWarehouses, [])
  const zones = useLoad(listZones, [])
  const locations = useLoad(listLocations, [])
  const [form, setForm] = useState({ warehouse_id: '', zone_id: '', code: '', loc_type: 'PICKABLE', pick_sequence: '' })
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const zoneName = (l: LocationRow) => zones.data?.find((z) => z.id === l.zone_id)?.name ?? ''
  const whName = (l: LocationRow) => warehouses.data?.find((w) => w.id === l.warehouse_id)?.name ?? ''

  async function create() {
    setError(''); setOk('')
    const err = await createLocation({
      warehouse_id: Number(form.warehouse_id || warehouses.data?.[0]?.id || 0),
      zone_id: form.zone_id ? Number(form.zone_id) : null,
      code: form.code,
      loc_type: form.loc_type,
      pick_sequence: form.pick_sequence.trim() === '' ? null : Number(form.pick_sequence),
    })
    if (err) return setError(err)
    setOk(`Đã thêm vị trí ${form.code.trim().toUpperCase()}`)
    setForm({ ...form, code: '', pick_sequence: '' })
    locations.reload()
  }

  async function toggle(l: LocationRow) {
    const err = await updateLocation(l.id, { active: l.active === 0 ? 1 : 0 })
    if (err) return setError(err)
    locations.reload()
  }

  return (
    <div className="space-y-4">
      <Notice>
        Vị trí quyết định thuật toán kho: hàng nhận vào vị trí loại RECEIVING (chờ QC),
        cất lên vị trí PICKABLE/BULK. Vị trí DAMAGE/HOLD không bao giờ được gợi ý cất hàng.
      </Notice>

      <Card className="space-y-3">
        <h2 className="font-semibold">Thêm vị trí</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Kho">
            <select className={inputClass} value={form.warehouse_id} onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}>
              <option value="">— Kho mặc định —</option>
              {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </select>
          </Field>
          <Field label="Khu (zone)">
            <select className={inputClass} value={form.zone_id} onChange={(e) => setForm({ ...form, zone_id: e.target.value })}>
              <option value="">— Không thuộc khu —</option>
              {zones.data?.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.code})</option>)}
            </select>
          </Field>
          <Field label="Mã vị trí *">
            <input className={inputClass} placeholder="A01-03" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label="Loại vị trí">
            <select className={inputClass} value={form.loc_type} onChange={(e) => setForm({ ...form, loc_type: e.target.value })}>
              {LOC_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </Field>
          <Field label="Thứ tự đi lấy (pick sequence)">
            <input className={inputClass} inputMode="numeric" placeholder="103" value={form.pick_sequence} onChange={(e) => setForm({ ...form, pick_sequence: e.target.value })} />
          </Field>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice>{ok}</Notice>}
        <Button kind="primary" onClick={create}>Thêm vị trí</Button>
      </Card>

      {locations.error && <Notice kind="error">{locations.error}</Notice>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(locations.data ?? []).map((l) => (
          <Card key={l.id} className="space-y-1">
            <p className="font-semibold">{l.code} <span className="font-normal text-slate-600">({TYPE_LABELS[l.loc_type] ?? l.loc_type})</span></p>
            <p className="text-sm text-slate-600">
              {whName(l)}{zoneName(l) ? ` · ${zoneName(l)}` : ''}
              {l.pick_sequence != null ? ` · thứ tự lấy ${l.pick_sequence}` : ''}
              {l.active === 0 ? ' · ĐANG TẮT' : ''}
            </p>
            <div className="pt-2">
              <Button kind={l.active === 0 ? 'primary' : 'danger'} onClick={() => toggle(l)}>
                {l.active === 0 ? 'Bật lại' : 'Tắt vị trí'}
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {(locations.data ?? []).length === 0 && !locations.loading && (
        <Notice>Chưa có vị trí nào. App tự seed kho chính với NHAN-01, A01-01, A01-02 ở lần chạy đầu.</Notice>
      )}
    </div>
  )
}
