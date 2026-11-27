import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import {
  freightErrText,
  getCarrierProfile,
  getOrgProfile,
  inviteLink,
  listDrivers,
  listLinksForGroup,
  listOrgDirectory,
  listRoutes,
  listVehicles,
  listWarehouses,
  reinviteLink,
  respondLink,
  saveDriver,
  saveRoute,
  saveVehicle,
  saveWarehouse,
  setDriverActive,
  setRouteActive,
  setVehicleActive,
  setWarehouseActive,
  upsertCarrierProfile,
  upsertOrgProfile,
  type DriverProfile,
  type OrgProfile,
  type ServiceRoute,
  type Vehicle,
  type WarehouseProfile,
} from '../../shared/supabase/freight'
import { ORG_TYPE_LABELS, type OrgType } from '../../domain/freight/profile'
import { SelfDeclaredNote, fmtDate, numOrNull, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightErrText(e))
  })

export default function ProfileTab({ ctx }: { ctx: FreightCtx }) {
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          getOrgProfile(ctx.groupId),
          getCarrierProfile(ctx.groupId),
          listWarehouses(ctx.groupId),
          listVehicles(ctx.groupId),
          listDrivers(ctx.groupId),
          listRoutes(ctx.groupId),
          listOrgDirectory(),
          listLinksForGroup(ctx.groupId),
        ]),
      ),
    [ctx.groupId],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải hồ sơ…</p>
  const [profile, carrierProfile, warehouses, vehicles, drivers, routes, directory, links] = data.data
  const orgType = profile?.org_type
  const isShipper = orgType === 'SHIPPER' || orgType === 'BOTH'
  const isCarrier = orgType === 'CARRIER' || orgType === 'BOTH'

  return (
    <div className="space-y-4">
      <SelfDeclaredNote />
      <OrgForm key={profile?.updated_at ?? 'new'} ctx={ctx} profile={profile} onSaved={data.reload} />
      {isShipper && <WarehousesSection ctx={ctx} items={warehouses} onChanged={data.reload} />}
      {isCarrier && (
        <>
          <CarrierExtraForm key={carrierProfile ? 'c1' : 'c0'} ctx={ctx} licenseNo={carrierProfile?.business_license_no ?? ''} note={carrierProfile?.capability_note ?? ''} onSaved={data.reload} />
          <VehiclesSection ctx={ctx} items={vehicles} onChanged={data.reload} />
          <DriversSection ctx={ctx} items={drivers} onChanged={data.reload} />
          <RoutesSection ctx={ctx} items={routes} onChanged={data.reload} />
        </>
      )}
      {profile && <LinksSection ctx={ctx} myType={orgType!} directory={directory} links={links} onChanged={data.reload} />}
    </div>
  )
}

function OrgForm({ ctx, profile, onSaved }: { ctx: FreightCtx; profile: OrgProfile | null; onSaved: () => void }) {
  const [orgType, setOrgType] = useState<OrgType>(profile?.org_type ?? 'SHIPPER')
  const [displayName, setDisplayName] = useState(profile?.display_name ?? ctx.groupName)
  const [legalName, setLegalName] = useState(profile?.legal_name ?? '')
  const [taxCode, setTaxCode] = useState(profile?.tax_code ?? '')
  const [contactName, setContactName] = useState(profile?.contact_name ?? '')
  const [contactPhone, setContactPhone] = useState(profile?.contact_phone ?? '')
  const [address, setAddress] = useState(profile?.address ?? '')
  const [province, setProvince] = useState(profile?.province ?? '')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setErr('')
    setMsg('')
    try {
      await upsertOrgProfile({
        groupId: ctx.groupId,
        orgType,
        displayName: displayName.trim(),
        legalName: strOrNull(legalName),
        taxCode: strOrNull(taxCode),
        contactName: strOrNull(contactName),
        contactPhone: strOrNull(contactPhone),
        address: strOrNull(address),
        province: strOrNull(province),
      })
      setMsg('Đã lưu hồ sơ tự khai.')
      onSaved()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Hồ sơ tổ chức (tự khai)</h3>
      <p className="text-slate-600">
        Khai một lần cho group “{ctx.groupName}”. Thông tin này hiển thị cho đối tác khi giao dịch — hệ thống không xác
        thực, các bên tự xác minh.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Loại tổ chức">
          <select className={inputClass} value={orgType} onChange={(e) => setOrgType(e.target.value as OrgType)}>
            {(Object.keys(ORG_TYPE_LABELS) as OrgType[]).map((t) => (
              <option key={t} value={t}>{ORG_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="Tên hiển thị *">
          <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Tên pháp nhân">
          <input className={inputClass} value={legalName} onChange={(e) => setLegalName(e.target.value)} />
        </Field>
        <Field label="Mã số thuế">
          <input className={inputClass} value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
        </Field>
        <Field label="Người liên hệ">
          <input className={inputClass} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Điện thoại liên hệ">
          <input className={inputClass} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Địa chỉ">
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Tỉnh/TP">
          <input className={inputClass} value={province} onChange={(e) => setProvince(e.target.value)} />
        </Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      <Button onClick={save} disabled={busy || displayName.trim() === ''}>{busy ? 'Đang lưu…' : 'Lưu hồ sơ'}</Button>
    </Card>
  )
}

function CarrierExtraForm({ ctx, licenseNo, note, onSaved }: { ctx: FreightCtx; licenseNo: string; note: string; onSaved: () => void }) {
  const [license, setLicense] = useState(licenseNo)
  const [cap, setCap] = useState(note)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  async function save() {
    setErr('')
    setMsg('')
    try {
      await upsertCarrierProfile(ctx.groupId, strOrNull(license), strOrNull(cap))
      setMsg('Đã lưu thông tin vận tải.')
      onSaved()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Thông tin vận tải (tự khai)</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Số giấy phép kinh doanh vận tải (nếu có)">
          <input className={inputClass} value={license} onChange={(e) => setLicense(e.target.value)} />
        </Field>
        <Field label="Ghi chú năng lực (khu vực mạnh, loại hàng nhận…)">
          <input className={inputClass} value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      <Button kind="secondary" onClick={save}>Lưu</Button>
    </Card>
  )
}

function WarehousesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: WarehouseProfile[]; onChanged: () => void }) {
  const empty = { name: '', address: '', province: '', dock_count: '', arrival_requirements: '', contact_name: '', contact_phone: '' }
  const [form, setForm] = useState(empty)
  const [editId, setEditId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  async function save() {
    setErr('')
    try {
      await saveWarehouse(ctx.groupId, editId, {
        name: form.name.trim(),
        address: form.address.trim(),
        province: strOrNull(form.province),
        lat: null,
        lng: null,
        dock_count: numOrNull(form.dock_count),
        arrival_requirements: strOrNull(form.arrival_requirements),
        contact_name: strOrNull(form.contact_name),
        contact_phone: strOrNull(form.contact_phone),
      })
      setForm(empty)
      setEditId(null)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Kho của đơn vị</h3>
      {items.length === 0 && <p className="text-slate-600">Chưa có kho nào.</p>}
      {items.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{w.name}</span>
          <span className="text-slate-600">{w.address}{w.province ? ` · ${w.province}` : ''}</span>
          {!w.active && <span className="text-slate-500">(đã ẩn)</span>}
          <span className="ml-auto flex gap-2">
            <Button kind="secondary" onClick={() => { setEditId(w.id); setForm({ name: w.name, address: w.address, province: w.province ?? '', dock_count: w.dock_count?.toString() ?? '', arrival_requirements: w.arrival_requirements ?? '', contact_name: w.contact_name ?? '', contact_phone: w.contact_phone ?? '' }) }}>Sửa</Button>
            <Button kind="secondary" onClick={() => setWarehouseActive(w.id, !w.active).then(onChanged).catch((e) => setErr(freightErrText(e)))}>{w.active ? 'Ẩn' : 'Hiện'}</Button>
          </span>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tên kho *"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Địa chỉ *"><input className={inputClass} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Tỉnh/TP"><input className={inputClass} value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} /></Field>
        <Field label="Số cửa xuất/nhập"><input className={inputClass} value={form.dock_count} onChange={(e) => setForm({ ...form, dock_count: e.target.value })} inputMode="numeric" /></Field>
        <Field label="Yêu cầu khi xe đến"><input className={inputClass} value={form.arrival_requirements} onChange={(e) => setForm({ ...form, arrival_requirements: e.target.value })} /></Field>
        <Field label="Liên hệ tại kho"><input className={inputClass} value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></Field>
        <Field label="Điện thoại kho"><input className={inputClass} value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} inputMode="tel" /></Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <Button kind="secondary" onClick={save} disabled={form.name.trim() === '' || form.address.trim() === ''}>{editId ? 'Lưu sửa kho' : 'Thêm kho'}</Button>
    </Card>
  )
}

function VehiclesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: Vehicle[]; onChanged: () => void }) {
  const empty = { plate: '', vehicle_type: 'Tải thùng', payload_kg: '', box_length_m: '', box_width_m: '', box_height_m: '', inspection_expires_at: '', insurance_expires_at: '' }
  const [form, setForm] = useState(empty)
  const [editId, setEditId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  async function save() {
    setErr('')
    try {
      await saveVehicle(ctx.groupId, editId, {
        plate: form.plate.trim(),
        vehicle_type: form.vehicle_type.trim(),
        payload_kg: numOrNull(form.payload_kg),
        box_length_m: numOrNull(form.box_length_m),
        box_width_m: numOrNull(form.box_width_m),
        box_height_m: numOrNull(form.box_height_m),
        inspection_expires_at: form.inspection_expires_at || null,
        insurance_expires_at: form.insurance_expires_at || null,
      })
      setForm(empty)
      setEditId(null)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Xe của đơn vị</h3>
      <p className="text-slate-600">Ngày hết hạn đăng kiểm/bảo hiểm chỉ để hiển thị cho đối tác tự đánh giá — hệ thống không chặn theo các mốc này.</p>
      {items.length === 0 && <p className="text-slate-600">Chưa có xe nào.</p>}
      {items.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{v.plate}</span>
          <span className="text-slate-600">
            {v.vehicle_type}{v.payload_kg ? ` · ${v.payload_kg} kg` : ''} · Đăng kiểm đến {fmtDate(v.inspection_expires_at)} · Bảo hiểm đến {fmtDate(v.insurance_expires_at)}
          </span>
          {!v.active && <span className="text-slate-500">(đã ẩn)</span>}
          <span className="ml-auto flex gap-2">
            <Button kind="secondary" onClick={() => { setEditId(v.id); setForm({ plate: v.plate, vehicle_type: v.vehicle_type, payload_kg: v.payload_kg?.toString() ?? '', box_length_m: v.box_length_m?.toString() ?? '', box_width_m: v.box_width_m?.toString() ?? '', box_height_m: v.box_height_m?.toString() ?? '', inspection_expires_at: v.inspection_expires_at ?? '', insurance_expires_at: v.insurance_expires_at ?? '' }) }}>Sửa</Button>
            <Button kind="secondary" onClick={() => setVehicleActive(v.id, !v.active).then(onChanged).catch((e) => setErr(freightErrText(e)))}>{v.active ? 'Ẩn' : 'Hiện'}</Button>
          </span>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Biển số *"><input className={inputClass} value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} /></Field>
        <Field label="Loại xe *"><input className={inputClass} value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })} /></Field>
        <Field label="Tải trọng (kg)"><input className={inputClass} value={form.payload_kg} onChange={(e) => setForm({ ...form, payload_kg: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Thùng dài (m)"><input className={inputClass} value={form.box_length_m} onChange={(e) => setForm({ ...form, box_length_m: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Thùng rộng (m)"><input className={inputClass} value={form.box_width_m} onChange={(e) => setForm({ ...form, box_width_m: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Thùng cao (m)"><input className={inputClass} value={form.box_height_m} onChange={(e) => setForm({ ...form, box_height_m: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Hạn đăng kiểm (hiển thị)"><input type="date" className={inputClass} value={form.inspection_expires_at} onChange={(e) => setForm({ ...form, inspection_expires_at: e.target.value })} /></Field>
        <Field label="Hạn bảo hiểm (hiển thị)"><input type="date" className={inputClass} value={form.insurance_expires_at} onChange={(e) => setForm({ ...form, insurance_expires_at: e.target.value })} /></Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <Button kind="secondary" onClick={save} disabled={form.plate.trim() === '' || form.vehicle_type.trim() === ''}>{editId ? 'Lưu sửa xe' : 'Thêm xe'}</Button>
    </Card>
  )
}

function DriversSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: DriverProfile[]; onChanged: () => void }) {
  const empty = { full_name: '', phone: '', license_class: '', license_expires_at: '' }
  const [form, setForm] = useState(empty)
  const [editId, setEditId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  async function save() {
    setErr('')
    try {
      await saveDriver(ctx.groupId, editId, {
        user_id: null,
        full_name: form.full_name.trim(),
        phone: strOrNull(form.phone),
        license_class: strOrNull(form.license_class),
        license_expires_at: form.license_expires_at || null,
      })
      setForm(empty)
      setEditId(null)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Tài xế của đơn vị</h3>
      <p className="text-slate-600">Hạn bằng lái chỉ để hiển thị — hệ thống không chặn theo mốc này.</p>
      {items.length === 0 && <p className="text-slate-600">Chưa có tài xế nào.</p>}
      {items.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{d.full_name}</span>
          <span className="text-slate-600">
            {d.phone ?? ''}{d.license_class ? ` · Bằng ${d.license_class}` : ''} · Hạn bằng đến {fmtDate(d.license_expires_at)}
          </span>
          {!d.active && <span className="text-slate-500">(đã ẩn)</span>}
          <span className="ml-auto flex gap-2">
            <Button kind="secondary" onClick={() => { setEditId(d.id); setForm({ full_name: d.full_name, phone: d.phone ?? '', license_class: d.license_class ?? '', license_expires_at: d.license_expires_at ?? '' }) }}>Sửa</Button>
            <Button kind="secondary" onClick={() => setDriverActive(d.id, !d.active).then(onChanged).catch((e) => setErr(freightErrText(e)))}>{d.active ? 'Ẩn' : 'Hiện'}</Button>
          </span>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Họ tên *"><input className={inputClass} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
        <Field label="Điện thoại"><input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" /></Field>
        <Field label="Hạng bằng"><input className={inputClass} value={form.license_class} onChange={(e) => setForm({ ...form, license_class: e.target.value })} /></Field>
        <Field label="Hạn bằng lái (hiển thị)"><input type="date" className={inputClass} value={form.license_expires_at} onChange={(e) => setForm({ ...form, license_expires_at: e.target.value })} /></Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <Button kind="secondary" onClick={save} disabled={form.full_name.trim() === ''}>{editId ? 'Lưu sửa tài xế' : 'Thêm tài xế'}</Button>
    </Card>
  )
}

function RoutesSection({ ctx, items, onChanged }: { ctx: FreightCtx; items: ServiceRoute[]; onChanged: () => void }) {
  const empty = { from_province: '', to_province: '', vehicle_type: '', ref_price: '', note: '' }
  const [form, setForm] = useState(empty)
  const [editId, setEditId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  async function save() {
    setErr('')
    try {
      await saveRoute(ctx.groupId, editId, {
        from_province: form.from_province.trim(),
        to_province: form.to_province.trim(),
        vehicle_type: strOrNull(form.vehicle_type),
        ref_price: numOrNull(form.ref_price),
        note: strOrNull(form.note),
      })
      setForm(empty)
      setEditId(null)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }
  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Tuyến năng lực</h3>
      {items.length === 0 && <p className="text-slate-600">Chưa khai tuyến nào.</p>}
      {items.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
          <span className="font-medium">{r.from_province} → {r.to_province}</span>
          <span className="text-slate-600">{r.vehicle_type ?? ''}{r.ref_price ? ` · tham khảo ${r.ref_price.toLocaleString('vi-VN')} đ` : ''}{r.note ? ` · ${r.note}` : ''}</span>
          {!r.active && <span className="text-slate-500">(đã ẩn)</span>}
          <span className="ml-auto flex gap-2">
            <Button kind="secondary" onClick={() => { setEditId(r.id); setForm({ from_province: r.from_province, to_province: r.to_province, vehicle_type: r.vehicle_type ?? '', ref_price: r.ref_price?.toString() ?? '', note: r.note ?? '' }) }}>Sửa</Button>
            <Button kind="secondary" onClick={() => setRouteActive(r.id, !r.active).then(onChanged).catch((e) => setErr(freightErrText(e)))}>{r.active ? 'Ẩn' : 'Hiện'}</Button>
          </span>
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tỉnh đi *"><input className={inputClass} value={form.from_province} onChange={(e) => setForm({ ...form, from_province: e.target.value })} /></Field>
        <Field label="Tỉnh đến *"><input className={inputClass} value={form.to_province} onChange={(e) => setForm({ ...form, to_province: e.target.value })} /></Field>
        <Field label="Loại xe"><input className={inputClass} value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })} /></Field>
        <Field label="Giá tham khảo (đ)"><input className={inputClass} value={form.ref_price} onChange={(e) => setForm({ ...form, ref_price: e.target.value })} inputMode="numeric" /></Field>
        <Field label="Ghi chú"><input className={inputClass} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <Button kind="secondary" onClick={save} disabled={form.from_province.trim() === '' || form.to_province.trim() === ''}>{editId ? 'Lưu sửa tuyến' : 'Thêm tuyến'}</Button>
    </Card>
  )
}

function LinksSection({
  ctx,
  myType,
  directory,
  links,
  onChanged,
}: {
  ctx: FreightCtx
  myType: OrgType
  directory: OrgProfile[]
  links: Awaited<ReturnType<typeof listLinksForGroup>>
  onChanged: () => void
}) {
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const partners = directory.filter((o) => {
    if (o.group_id === ctx.groupId) return false
    if (myType === 'BOTH' || o.org_type === 'BOTH') return true
    return o.org_type !== myType
  })
  const linkWith = (otherGroupId: string) =>
    links.find(
      (l) =>
        (l.shipper_group_id === ctx.groupId && l.carrier_group_id === otherGroupId) ||
        (l.carrier_group_id === ctx.groupId && l.shipper_group_id === otherGroupId),
    )

  async function invite(other: OrgProfile) {
    setErr('')
    setMsg('')
    // Phía chủ hàng là nhóm có hàng; nếu tôi là nhà xe thì tôi ở phía carrier.
    const iAmShipper = myType === 'SHIPPER' || (myType === 'BOTH' && other.org_type === 'CARRIER')
    try {
      await inviteLink(iAmShipper ? ctx.groupId : other.group_id, iAmShipper ? other.group_id : ctx.groupId, ctx.me)
      setMsg(`Đã gửi lời mời kết nối tới ${other.display_name}.`)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }

  async function respond(id: string, accept: boolean) {
    setErr('')
    try {
      await respondLink(id, accept)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    }
  }

  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Mạng lưới kết nối (NETWORK)</h3>
      <p className="text-slate-600">
        Tải đăng ở mức NETWORK chỉ hiện với các đơn vị đã kết nối hai chiều. Kết nối cần phía còn lại xác nhận.
      </p>
      <SelfDeclaredNote />
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      {partners.length === 0 && <p className="text-slate-600">Chưa có tổ chức khác trong thư mục.</p>}
      {partners.map((o) => {
        const l = linkWith(o.group_id)
        const incoming = l && l.status === 'PENDING' && l.created_by !== ctx.me
        return (
          <div key={o.group_id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
            <span className="font-medium">{o.display_name}</span>
            <span className="text-slate-600">
              {ORG_TYPE_LABELS[o.org_type]}{o.province ? ` · ${o.province}` : ''}{o.contact_phone ? ` · ${o.contact_phone}` : ''}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {!l && <Button kind="secondary" onClick={() => invite(o)}>Mời kết nối</Button>}
              {l?.status === 'PENDING' && !incoming && <span className="text-slate-500">Đang chờ phía kia xác nhận…</span>}
              {l?.status === 'PENDING' && incoming && (
                <>
                  <Button onClick={() => respond(l.id, true)}>Chấp nhận</Button>
                  <Button kind="secondary" onClick={() => respond(l.id, false)}>Từ chối</Button>
                </>
              )}
              {l?.status === 'ACCEPTED' && <span className="font-medium text-emerald-700">Đã kết nối</span>}
              {l?.status === 'ENDED' && (
                <Button
                  kind="secondary"
                  onClick={() =>
                    reinviteLink(l.id, ctx.me)
                      .then(onChanged)
                      .catch((e) => setErr(freightErrText(e)))
                  }
                >
                  Mời lại
                </Button>
              )}
            </span>
          </div>
        )
      })}
    </Card>
  )
}
