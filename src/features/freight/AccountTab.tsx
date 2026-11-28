import { useState, type ReactNode } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import { FormDialog } from '../../shared/ui/FormDialog'
import { confirmDialog, noticeDialog } from '../../shared/ui/Dialog'
import {
  deleteMyDriver,
  deleteMyRoute,
  deleteMyVehicle,
  deleteMyWarehouse,
  freightAcctErrText,
  listAccountDirectory,
  listMyDrivers,
  listMyRoutes,
  listMyVehicles,
  listMyWarehouses,
  saveMyDriver,
  saveMyRoute,
  saveMyVehicle,
  saveMyWarehouse,
  setMyDriverActive,
  setMyRouteActive,
  setMyVehicleActive,
  setMyWarehouseActive,
  upsertMyAccountProfile,
  type MyDriver,
  type MyRoute,
  type MyVehicle,
  type MyWarehouse,
} from '../../shared/supabase/freightAccount'
import {
  listDrivers,
  listMyGroups,
  listRoutes,
  listVehicles,
  listWarehouses,
} from '../../shared/supabase/freight'
import { validateDriver, validateServiceRoute, validateVehicle } from '../../domain/freight/profile'
import { validateWarehouse } from '../../domain/freight/account'
import { ProfileDialog } from './ProfileDialog'
import { SelfDeclaredNote, fmtDate, numOrNull, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightAcctErrText(e))
  })

export default function AccountTab({ ctx, onAccountChanged }: { ctx: FreightCtx; onAccountChanged: () => void }) {
  const a = ctx.account
  const [profileOpen, setProfileOpen] = useState<null | 'edit' | 'shipper' | 'carrier'>(null)
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          listMyWarehouses(ctx.me),
          listMyVehicles(ctx.me),
          listMyDrivers(ctx.me),
          listMyRoutes(ctx.me),
        ]),
      ),
    [ctx.me],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải đăng ký của tôi…</p>
  const [warehouses, vehicles, drivers, routes] = data.data
  const migrated =
    warehouses.some((w) => w.legacy_source_id) ||
    vehicles.some((v) => v.legacy_source_id) ||
    drivers.some((d) => d.legacy_source_id) ||
    routes.some((r) => r.legacy_source_id)

  async function dropRole(role: 'shipper' | 'carrier') {
    const other = role === 'shipper' ? a.is_carrier : a.is_shipper
    if (!other) {
      await noticeDialog('Không bỏ được vai trò duy nhất còn lại — hồ sơ phải có ít nhất một vai trò (chủ kho hoặc vận tải).')
      return
    }
    const ok = await confirmDialog(
      role === 'shipper'
        ? 'Bỏ vai trò Chủ kho? Bạn sẽ không đăng tải mới được nữa. Dữ liệu kho, tải và chuyến cũ KHÔNG bị xoá.'
        : 'Bỏ vai trò Vận tải? Bạn sẽ không nhận chỉ định mới được nữa. Dữ liệu đội xe và chuyến cũ KHÔNG bị xoá.',
      { okText: 'Bỏ vai trò', danger: true },
    )
    if (!ok) return
    try {
      await upsertMyAccountProfile({
        displayName: a.display_name,
        legalName: a.legal_name,
        taxCode: a.tax_code,
        contactName: a.contact_name,
        contactPhone: a.contact_phone,
        address: a.address,
        province: a.province,
        isShipper: role === 'shipper' ? false : a.is_shipper,
        isCarrier: role === 'carrier' ? false : a.is_carrier,
        businessLicenseNo: a.business_license_no,
        capabilityNote: a.capability_note,
      })
      onAccountChanged()
    } catch (e) {
      await noticeDialog(freightAcctErrText(e))
    }
  }

  return (
    <div className="space-y-4">
      <SelfDeclaredNote />
      {migrated && (
        <Notice>
          Một số kho/xe/tài xế/tuyến dưới đây được chuyển từ group của bạn (mô hình cũ) sang tài khoản của bạn — dữ
          liệu cũ trong group vẫn còn nguyên để đối chiếu.
        </Notice>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <RoleCard
          title="Chủ kho / chủ hàng"
          registered={a.is_shipper}
          desc="Đăng ký để đăng tải tìm xe và quản lý các kho của bạn."
          summary={
            <>
              <p className="font-medium">{a.display_name}</p>
              <p className="text-slate-600">
                {a.contact_phone ?? 'Chưa khai SĐT'}
                {a.province ? ` · ${a.province}` : ''} · {warehouses.length} kho
              </p>
            </>
          }
          onRegister={() => setProfileOpen('shipper')}
          onEdit={() => setProfileOpen('edit')}
          onDrop={() => dropRole('shipper')}
        />
        <RoleCard
          title="Vận tải (đội xe)"
          registered={a.is_carrier}
          desc="Đăng ký để nhận chuyến và quản lý đội xe của bạn."
          summary={
            <>
              <p className="font-medium">{a.display_name}</p>
              <p className="text-slate-600">
                {a.contact_phone ?? 'Chưa khai SĐT'}
                {a.province ? ` · ${a.province}` : ''} · {vehicles.length} xe · {drivers.length} tài xế
              </p>
              {a.business_license_no && <p className="text-slate-600">Giấy phép KD vận tải (tự khai): {a.business_license_no}</p>}
              {a.capability_note && <p className="text-slate-600">Năng lực: {a.capability_note}</p>}
            </>
          }
          onRegister={() => setProfileOpen('carrier')}
          onEdit={() => setProfileOpen('edit')}
          onDrop={() => dropRole('carrier')}
        />
      </div>

      {a.is_shipper && <WarehousesSection ctx={ctx} items={warehouses} onChanged={data.reload} />}
      {a.is_carrier && (
        <>
          <VehiclesSection ctx={ctx} items={vehicles} onChanged={data.reload} />
          <DriversSection ctx={ctx} items={drivers} onChanged={data.reload} />
          <RoutesSection ctx={ctx} items={routes} onChanged={data.reload} />
        </>
      )}

      {profileOpen && (
        <ProfileDialog
          initial={a}
          presetRole={profileOpen === 'edit' ? undefined : profileOpen}
          onClose={() => setProfileOpen(null)}
          onSaved={() => {
            setProfileOpen(null)
            onAccountChanged()
          }}
        />
      )}
    </div>
  )
}

function RoleCard({
  title,
  registered,
  desc,
  summary,
  onRegister,
  onEdit,
  onDrop,
}: {
  title: string
  registered: boolean
  desc: string
  summary: ReactNode
  onRegister: () => void
  onEdit: () => void
  onDrop: () => void
}) {
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">{title}</h3>
      {registered ? (
        <>
          {summary}
          <div className="flex flex-wrap gap-2">
            <Button kind="secondary" onClick={onEdit}>Sửa hồ sơ</Button>
            <Button kind="secondary" onClick={onDrop}>Bỏ vai trò này</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-slate-600">{desc}</p>
          <Button onClick={onRegister}>Đăng ký {title.toLowerCase()}</Button>
        </>
      )}
    </Card>
  )
}

// ----- Khung danh sách dùng chung: tiêu đề + nút Thêm, lỗi tại chỗ -----

function ListShell({
  title,
  addLabel,
  onAdd,
  err,
  children,
}: {
  title: string
  addLabel: string
  onAdd: () => void
  err: string
  children: ReactNode
}) {
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        <span className="ml-auto">
          <Button onClick={onAdd}>{addLabel}</Button>
        </span>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {children}
    </Card>
  )
}

function RowActions({
  active,
  onEdit,
  onToggle,
  onDelete,
}: {
  active: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <span className="ml-auto flex flex-wrap gap-2">
      <Button kind="secondary" onClick={onEdit}>Sửa</Button>
      <Button kind="secondary" onClick={onToggle}>{active ? 'Ngừng dùng' : 'Kích hoạt'}</Button>
      <Button kind="danger" onClick={onDelete}>Xoá</Button>
    </span>
  )
}

// ----- Sao chép từ group của tôi (prefill — thiết kế 1.8.3) -----

type CopyKind = 'warehouse' | 'vehicle' | 'driver' | 'route'

function CopyFromGroup({ kind, onPick }: { kind: CopyKind; onPick: (values: Record<string, string>) => void }) {
  const [groupId, setGroupId] = useState('')
  const [itemId, setItemId] = useState('')
  const groups = useLoad(() => wrap(listMyGroups()), [])
  const items = useLoad(
    async () => {
      if (!groupId) return [] as { id: string; label: string; values: Record<string, string> }[]
      if (kind === 'warehouse') {
        const rows = await listWarehouses(groupId)
        return rows.map((w) => ({
          id: w.id,
          label: `${w.name} — ${w.address}`,
          values: {
            name: w.name, address: w.address, province: w.province ?? '',
            dock_count: w.dock_count?.toString() ?? '', arrival_requirements: w.arrival_requirements ?? '',
            contact_name: w.contact_name ?? '', contact_phone: w.contact_phone ?? '',
            lat: w.lat?.toString() ?? '', lng: w.lng?.toString() ?? '',
          },
        }))
      }
      if (kind === 'vehicle') {
        const rows = await listVehicles(groupId)
        return rows.map((v) => ({
          id: v.id,
          label: `${v.plate} · ${v.vehicle_type}`,
          values: {
            plate: v.plate, vehicle_type: v.vehicle_type, payload_kg: v.payload_kg?.toString() ?? '',
            box_length_m: v.box_length_m?.toString() ?? '', box_width_m: v.box_width_m?.toString() ?? '',
            box_height_m: v.box_height_m?.toString() ?? '',
            inspection_expires_at: v.inspection_expires_at ?? '', insurance_expires_at: v.insurance_expires_at ?? '',
          },
        }))
      }
      if (kind === 'driver') {
        const rows = await listDrivers(groupId)
        return rows.map((d) => ({
          id: d.id,
          label: d.full_name,
          values: { full_name: d.full_name, phone: d.phone ?? '', license_class: d.license_class ?? '', license_expires_at: d.license_expires_at ?? '' },
        }))
      }
      const rows = await listRoutes(groupId)
      return rows.map((r) => ({
        id: r.id,
        label: `${r.from_province} → ${r.to_province}`,
        values: { from_province: r.from_province, to_province: r.to_province, vehicle_type: r.vehicle_type ?? '', ref_price: r.ref_price?.toString() ?? '', note: r.note ?? '' },
      }))
    },
    [groupId, kind],
  )

  return (
    <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
      <Field label="Sao chép từ group của tôi (không bắt buộc)">
        <select className={inputClass} value={groupId} onChange={(e) => { setGroupId(e.target.value); setItemId('') }}>
          <option value="">— Chọn group —</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Chọn mục để điền sẵn">
        <select
          className={inputClass}
          value={itemId}
          disabled={!groupId}
          onChange={(e) => {
            setItemId(e.target.value)
            const it = (items.data ?? []).find((x) => x.id === e.target.value)
            if (it) onPick(it.values)
          }}
        >
          <option value="">— Chọn mục —</option>
          {(items.data ?? []).map((it) => (
            <option key={it.id} value={it.id}>{it.label}</option>
          ))}
        </select>
      </Field>
    </div>
  )
}

// ----- Kho của tôi -----

const WH_EMPTY = { name: '', address: '', province: '', dock_count: '', arrival_requirements: '', contact_name: '', contact_phone: '', open_from: '', open_to: '', lat: '', lng: '' }

function WarehousesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: MyWarehouse[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<null | { edit: MyWarehouse | null }>(null)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<void>) => {
    setErr('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }
  return (
    <ListShell title="Kho của tôi" addLabel="Thêm kho" onAdd={() => setDialog({ edit: null })} err={err}>
      {items.length === 0 && <p className="text-slate-600">Chưa có kho nào — bấm “Thêm kho” để tạo.</p>}
      {items.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{w.name}</span>
          <span className="text-slate-600">{w.address}{w.province ? ` · ${w.province}` : ''}</span>
          {w.legacy_source_id && <span className="text-slate-400">(chuyển từ mô hình cũ)</span>}
          {!w.active && <span className="text-slate-500">(đã ngừng dùng)</span>}
          <RowActions
            active={w.active}
            onEdit={() => setDialog({ edit: w })}
            onToggle={() => act(() => setMyWarehouseActive(w.id, !w.active))}
            onDelete={() =>
              confirmDialog(`Xoá kho “${w.name}”? Tải đã đăng dùng địa chỉ text riêng nên không bị ảnh hưởng.`, { okText: 'Xoá', danger: true }).then(async (ok) => {
                if (ok) await act(() => deleteMyWarehouse(w.id))
              })
            }
          />
        </div>
      ))}
      {dialog && (
        <WarehouseDialog
          ctx={ctx}
          initial={dialog.edit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            onChanged()
          }}
        />
      )}
    </ListShell>
  )
}

function WarehouseDialog({ ctx, initial, onClose, onSaved }: { ctx: FreightCtx; initial: MyWarehouse | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(
    initial
      ? {
          name: initial.name, address: initial.address, province: initial.province ?? '',
          dock_count: initial.dock_count?.toString() ?? '', arrival_requirements: initial.arrival_requirements ?? '',
          contact_name: initial.contact_name ?? '', contact_phone: initial.contact_phone ?? '',
          open_from: initial.open_hours?.open ?? '', open_to: initial.open_hours?.close ?? '',
          lat: initial.lat?.toString() ?? '', lng: initial.lng?.toString() ?? '',
        }
      : WH_EMPTY,
  )
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    const input = {
      name: form.name.trim(),
      address: form.address.trim(),
      province: strOrNull(form.province),
      contact_name: strOrNull(form.contact_name),
      contact_phone: strOrNull(form.contact_phone),
      dock_count: numOrNull(form.dock_count),
    }
    const v = validateWarehouse(input)
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      await saveMyWarehouse(ctx.me, initial?.id ?? null, {
        ...input,
        lat: numOrNull(form.lat),
        lng: numOrNull(form.lng),
        open_hours: form.open_from || form.open_to ? { open: form.open_from || undefined, close: form.open_to || undefined } : null,
        arrival_requirements: strOrNull(form.arrival_requirements),
      })
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={initial ? 'Sửa kho' : 'Thêm kho'} onClose={onClose} onSubmit={submit} busy={busy} error={err}>
      {!initial && <CopyFromGroup kind="warehouse" onPick={(vals) => setForm((f) => ({ ...f, ...vals }))} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tên kho *"><input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Địa chỉ *"><input className={inputClass} value={form.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Tỉnh/TP"><input className={inputClass} value={form.province} onChange={(e) => set('province', e.target.value)} /></Field>
        <Field label="Số cửa xuất/nhập"><input className={inputClass} value={form.dock_count} onChange={(e) => set('dock_count', e.target.value)} inputMode="numeric" /></Field>
        <Field label="Giờ mở cửa (từ)"><input type="time" className={inputClass} value={form.open_from} onChange={(e) => set('open_from', e.target.value)} /></Field>
        <Field label="Giờ đóng cửa (đến)"><input type="time" className={inputClass} value={form.open_to} onChange={(e) => set('open_to', e.target.value)} /></Field>
        <Field label="Liên hệ tại kho"><input className={inputClass} value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></Field>
        <Field label="Điện thoại kho"><input className={inputClass} value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Yêu cầu khi xe đến"><input className={inputClass} value={form.arrival_requirements} onChange={(e) => set('arrival_requirements', e.target.value)} /></Field>
        <Field label="Vĩ độ (tuỳ chọn)"><input className={inputClass} value={form.lat} onChange={(e) => set('lat', e.target.value)} inputMode="decimal" /></Field>
        <Field label="Kinh độ (tuỳ chọn)"><input className={inputClass} value={form.lng} onChange={(e) => set('lng', e.target.value)} inputMode="decimal" /></Field>
      </div>
    </FormDialog>
  )
}

// ----- Xe của tôi -----

const VEHICLE_TYPES = ['Tải thùng', 'Tải mui bạt', 'Container', 'Xe lạnh', 'Xe ben', 'Đầu kéo', 'Xe cẩu', 'Bán tải']
const V_EMPTY = { plate: '', vehicle_type: 'Tải thùng', payload_kg: '', box_length_m: '', box_width_m: '', box_height_m: '', inspection_expires_at: '', insurance_expires_at: '' }

function VehiclesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: MyVehicle[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<null | { edit: MyVehicle | null }>(null)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<void>) => {
    setErr('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }
  return (
    <ListShell title="Xe của tôi" addLabel="Thêm xe" onAdd={() => setDialog({ edit: null })} err={err}>
      <p className="text-slate-600">Ngày hết hạn đăng kiểm/bảo hiểm chỉ để hiển thị cho đối tác tự đánh giá — hệ thống không chặn chuyến theo các mốc này.</p>
      {items.length === 0 && <p className="text-slate-600">Chưa có xe nào — bấm “Thêm xe” để tạo.</p>}
      {items.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{v.plate}</span>
          <span className="text-slate-600">
            {v.vehicle_type}{v.payload_kg ? ` · ${v.payload_kg} kg` : ''} · Đăng kiểm đến {fmtDate(v.inspection_expires_at)} · Bảo hiểm đến {fmtDate(v.insurance_expires_at)}
          </span>
          {v.legacy_source_id && <span className="text-slate-400">(chuyển từ mô hình cũ)</span>}
          {!v.active && <span className="text-slate-500">(đã ngừng dùng)</span>}
          <RowActions
            active={v.active}
            onEdit={() => setDialog({ edit: v })}
            onToggle={() => act(() => setMyVehicleActive(v.id, !v.active))}
            onDelete={() =>
              confirmDialog(`Xoá xe ${v.plate}? Chuyến đã gán xe này sẽ hiển thị “xe đã xoá” thay vì mất chuyến.`, { okText: 'Xoá', danger: true }).then(async (ok) => {
                if (ok) await act(() => deleteMyVehicle(v.id))
              })
            }
          />
        </div>
      ))}
      {dialog && (
        <VehicleDialog
          ctx={ctx}
          initial={dialog.edit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            onChanged()
          }}
        />
      )}
    </ListShell>
  )
}

function VehicleDialog({ ctx, initial, onClose, onSaved }: { ctx: FreightCtx; initial: MyVehicle | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(
    initial
      ? {
          plate: initial.plate, vehicle_type: initial.vehicle_type, payload_kg: initial.payload_kg?.toString() ?? '',
          box_length_m: initial.box_length_m?.toString() ?? '', box_width_m: initial.box_width_m?.toString() ?? '',
          box_height_m: initial.box_height_m?.toString() ?? '',
          inspection_expires_at: initial.inspection_expires_at ?? '', insurance_expires_at: initial.insurance_expires_at ?? '',
        }
      : V_EMPTY,
  )
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    const input = {
      plate: form.plate.trim(),
      vehicle_type: form.vehicle_type.trim(),
      payload_kg: numOrNull(form.payload_kg),
      inspection_expires_at: form.inspection_expires_at || null,
      insurance_expires_at: form.insurance_expires_at || null,
    }
    const v = validateVehicle(input)
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      await saveMyVehicle(ctx.me, initial?.id ?? null, {
        ...input,
        box_length_m: numOrNull(form.box_length_m),
        box_width_m: numOrNull(form.box_width_m),
        box_height_m: numOrNull(form.box_height_m),
      })
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={initial ? 'Sửa xe' : 'Thêm xe'} onClose={onClose} onSubmit={submit} busy={busy} error={err}>
      {!initial && <CopyFromGroup kind="vehicle" onPick={(vals) => setForm((f) => ({ ...f, ...vals }))} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Biển số *"><input className={inputClass} value={form.plate} onChange={(e) => set('plate', e.target.value)} /></Field>
        <Field label="Loại xe *">
          <input className={inputClass} value={form.vehicle_type} onChange={(e) => set('vehicle_type', e.target.value)} list="wa-vehicle-types" />
          <datalist id="wa-vehicle-types">
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Tải trọng (kg)"><input className={inputClass} value={form.payload_kg} onChange={(e) => set('payload_kg', e.target.value)} inputMode="decimal" /></Field>
        <Field label="Thùng dài (m)"><input className={inputClass} value={form.box_length_m} onChange={(e) => set('box_length_m', e.target.value)} inputMode="decimal" /></Field>
        <Field label="Thùng rộng (m)"><input className={inputClass} value={form.box_width_m} onChange={(e) => set('box_width_m', e.target.value)} inputMode="decimal" /></Field>
        <Field label="Thùng cao (m)"><input className={inputClass} value={form.box_height_m} onChange={(e) => set('box_height_m', e.target.value)} inputMode="decimal" /></Field>
        <Field label="Hạn đăng kiểm (chỉ hiển thị)"><input type="date" className={inputClass} value={form.inspection_expires_at} onChange={(e) => set('inspection_expires_at', e.target.value)} /></Field>
        <Field label="Hạn bảo hiểm (chỉ hiển thị)"><input type="date" className={inputClass} value={form.insurance_expires_at} onChange={(e) => set('insurance_expires_at', e.target.value)} /></Field>
      </div>
      <p className="text-slate-500">Ngày hết hạn chỉ để đối tác xem — hệ thống không chặn chuyến vì các ngày này.</p>
    </FormDialog>
  )
}

// ----- Tài xế của tôi -----

const D_EMPTY = { full_name: '', phone: '', license_class: '', license_expires_at: '' }

function DriversSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: MyDriver[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<null | { edit: MyDriver | null }>(null)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<void>) => {
    setErr('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }
  return (
    <ListShell title="Tài xế của tôi" addLabel="Thêm tài xế" onAdd={() => setDialog({ edit: null })} err={err}>
      <p className="text-slate-600">Hạn bằng lái chỉ để hiển thị — hệ thống không chặn theo mốc này.</p>
      {items.length === 0 && <p className="text-slate-600">Chưa có tài xế nào — bấm “Thêm tài xế” để tạo.</p>}
      {items.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{d.full_name}</span>
          <span className="text-slate-600">
            {d.phone ?? ''}
            {d.license_class ? ` · Bằng ${d.license_class}` : ''} · Hạn bằng đến {fmtDate(d.license_expires_at)}
            {d.user_id ? ' · Đã liên kết tài khoản' : ''}
          </span>
          {d.legacy_source_id && <span className="text-slate-400">(chuyển từ mô hình cũ)</span>}
          {!d.active && <span className="text-slate-500">(đã ngừng dùng)</span>}
          <RowActions
            active={d.active}
            onEdit={() => setDialog({ edit: d })}
            onToggle={() => act(() => setMyDriverActive(d.id, !d.active))}
            onDelete={() =>
              confirmDialog(`Xoá tài xế ${d.full_name}?`, { okText: 'Xoá', danger: true }).then(async (ok) => {
                if (ok) await act(() => deleteMyDriver(d.id))
              })
            }
          />
        </div>
      ))}
      {dialog && (
        <DriverDialog
          ctx={ctx}
          initial={dialog.edit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            onChanged()
          }}
        />
      )}
    </ListShell>
  )
}

function DriverDialog({ ctx, initial, onClose, onSaved }: { ctx: FreightCtx; initial: MyDriver | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(
    initial
      ? { full_name: initial.full_name, phone: initial.phone ?? '', license_class: initial.license_class ?? '', license_expires_at: initial.license_expires_at ?? '' }
      : D_EMPTY,
  )
  const [userId, setUserId] = useState<string | null>(initial?.user_id ?? null)
  const [linkQuery, setLinkQuery] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const candidates = useLoad(
    async () => (linkQuery.trim().length >= 2 ? listAccountDirectory({ search: linkQuery.trim() }) : []),
    [linkQuery],
  )

  async function submit() {
    const input = {
      full_name: form.full_name.trim(),
      phone: strOrNull(form.phone),
      license_class: strOrNull(form.license_class),
      license_expires_at: form.license_expires_at || null,
    }
    const v = validateDriver(input)
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      await saveMyDriver(ctx.me, initial?.id ?? null, { ...input, user_id: userId })
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={initial ? 'Sửa tài xế' : 'Thêm tài xế'} onClose={onClose} onSubmit={submit} busy={busy} error={err}>
      {!initial && <CopyFromGroup kind="driver" onPick={(vals) => setForm((f) => ({ ...f, ...vals }))} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Họ tên *"><input className={inputClass} value={form.full_name} onChange={(e) => set('full_name', e.target.value)} /></Field>
        <Field label="Điện thoại"><input className={inputClass} value={form.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Hạng bằng"><input className={inputClass} value={form.license_class} onChange={(e) => set('license_class', e.target.value)} /></Field>
        <Field label="Hạn bằng lái (chỉ hiển thị)"><input type="date" className={inputClass} value={form.license_expires_at} onChange={(e) => set('license_expires_at', e.target.value)} /></Field>
      </div>
      <p className="text-slate-500">Ngày hết hạn chỉ để đối tác xem — hệ thống không chặn chuyến vì ngày này.</p>
      <div className="space-y-2">
        <Field label="Liên kết tài khoản của tài xế (không bắt buộc — để tài xế tự đăng nhập và bấm mốc chuyến)">
          <input
            className={inputClass}
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
            placeholder="Gõ tên hoặc SĐT của tài xế (ít nhất 2 ký tự)…"
          />
        </Field>
        {userId ? (
          <p className="text-slate-600">
            Đã liên kết một tài khoản.{' '}
            <Button kind="secondary" onClick={() => setUserId(null)}>Bỏ liên kết</Button>
          </p>
        ) : (
          (candidates.data ?? [])
            .filter((p) => p.account_id !== ctx.me)
            .slice(0, 5)
            .map((p) => (
              <div key={p.account_id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.display_name}</span>
                <span className="text-slate-600">{p.contact_phone ?? ''}{p.province ? ` · ${p.province}` : ''}</span>
                <span className="ml-auto">
                  <Button kind="secondary" onClick={() => { setUserId(p.account_id); setLinkQuery('') }}>Liên kết tài khoản này</Button>
                </span>
              </div>
            ))
        )}
      </div>
    </FormDialog>
  )
}

// ----- Tuyến năng lực -----

const R_EMPTY = { from_province: '', to_province: '', vehicle_type: '', ref_price: '', note: '' }

function RoutesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: MyRoute[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<null | { edit: MyRoute | null }>(null)
  const [err, setErr] = useState('')
  const act = async (fn: () => Promise<void>) => {
    setErr('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }
  return (
    <ListShell title="Tuyến năng lực" addLabel="Thêm tuyến" onAdd={() => setDialog({ edit: null })} err={err}>
      {items.length === 0 && <p className="text-slate-600">Chưa khai tuyến nào — bấm “Thêm tuyến” để tạo.</p>}
      {items.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{r.from_province} → {r.to_province}</span>
          <span className="text-slate-600">
            {r.vehicle_type ?? ''}
            {r.ref_price ? ` · tham khảo ${r.ref_price.toLocaleString('vi-VN')} đ` : ''}
            {r.note ? ` · ${r.note}` : ''}
          </span>
          {r.legacy_source_id && <span className="text-slate-400">(chuyển từ mô hình cũ)</span>}
          {!r.active && <span className="text-slate-500">(đã ngừng dùng)</span>}
          <RowActions
            active={r.active}
            onEdit={() => setDialog({ edit: r })}
            onToggle={() => act(() => setMyRouteActive(r.id, !r.active))}
            onDelete={() =>
              confirmDialog(`Xoá tuyến ${r.from_province} → ${r.to_province}?`, { okText: 'Xoá', danger: true }).then(async (ok) => {
                if (ok) await act(() => deleteMyRoute(r.id))
              })
            }
          />
        </div>
      ))}
      {dialog && (
        <RouteDialog
          ctx={ctx}
          initial={dialog.edit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null)
            onChanged()
          }}
        />
      )}
    </ListShell>
  )
}

function RouteDialog({ ctx, initial, onClose, onSaved }: { ctx: FreightCtx; initial: MyRoute | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(
    initial
      ? { from_province: initial.from_province, to_province: initial.to_province, vehicle_type: initial.vehicle_type ?? '', ref_price: initial.ref_price?.toString() ?? '', note: initial.note ?? '' }
      : R_EMPTY,
  )
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  async function submit() {
    const input = { from_province: form.from_province.trim(), to_province: form.to_province.trim(), ref_price: numOrNull(form.ref_price) }
    const v = validateServiceRoute(input)
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      await saveMyRoute(ctx.me, initial?.id ?? null, { ...input, vehicle_type: strOrNull(form.vehicle_type), note: strOrNull(form.note) })
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={initial ? 'Sửa tuyến' : 'Thêm tuyến'} onClose={onClose} onSubmit={submit} busy={busy} error={err}>
      {!initial && <CopyFromGroup kind="route" onPick={(vals) => setForm((f) => ({ ...f, ...vals }))} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tỉnh đi *"><input className={inputClass} value={form.from_province} onChange={(e) => set('from_province', e.target.value)} /></Field>
        <Field label="Tỉnh đến *"><input className={inputClass} value={form.to_province} onChange={(e) => set('to_province', e.target.value)} /></Field>
        <Field label="Loại xe"><input className={inputClass} value={form.vehicle_type} onChange={(e) => set('vehicle_type', e.target.value)} /></Field>
        <Field label="Giá tham khảo (đ)"><input className={inputClass} value={form.ref_price} onChange={(e) => set('ref_price', e.target.value)} inputMode="numeric" /></Field>
        <Field label="Ghi chú"><input className={inputClass} value={form.note} onChange={(e) => set('note', e.target.value)} /></Field>
      </div>
      <p className="text-slate-500">Giá tham chiếu là giá bạn tự công bố để đối tác tham khảo, không phải cam kết.</p>
    </FormDialog>
  )
}
