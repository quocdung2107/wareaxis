import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import {
  assignBooking,
  cancelLoad,
  createLoad,
  freightErrText,
  getOrgProfile,
  listGroupOrders,
  listMyLoads,
  listOrgDirectory,
  listVisibleLoads,
  listWarehouses,
  type FreightLoad,
  type OrgProfile,
  type PublicLoad,
} from '../../shared/supabase/freight'
import { LOAD_STATUS_LABELS, LOAD_VISIBILITY_LABELS, validateLoadInput, type LoadVisibility } from '../../domain/freight/load'
import { ORG_TYPE_LABELS } from '../../domain/freight/profile'
import { SelfDeclaredNote, fmtDateTime, fmtMoney, localToIso, numOrNull, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightErrText(e))
  })

export default function LoadsTab({ ctx }: { ctx: FreightCtx }) {
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          getOrgProfile(ctx.groupId),
          listMyLoads(ctx.groupId),
          listVisibleLoads(),
          listOrgDirectory(),
          listGroupOrders(ctx.groupId),
          listWarehouses(ctx.groupId),
        ]),
      ),
    [ctx.groupId],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải…</p>
  const [profile, myLoads, visible, directory, orders, warehouses] = data.data
  const isShipper = profile?.org_type === 'SHIPPER' || profile?.org_type === 'BOTH'
  const isCarrier = profile?.org_type === 'CARRIER' || profile?.org_type === 'BOTH'
  const carriers = directory.filter((o) => o.group_id !== ctx.groupId && (o.org_type === 'CARRIER' || o.org_type === 'BOTH'))
  const othersLoads = visible.filter((l) => l.shipper_group_id !== ctx.groupId)

  return (
    <div className="space-y-4">
      {!profile && (
        <Notice kind="warn">Nhóm của bạn chưa khai hồ sơ tổ chức — hãy khai ở tab “Hồ sơ đơn vị” trước khi đăng tải hoặc nhận chuyến.</Notice>
      )}
      {isShipper && (
        <CreateLoadForm ctx={ctx} orders={orders} warehouses={warehouses} carriers={carriers} onCreated={data.reload} />
      )}
      {isShipper && (
        <Card className="space-y-3">
          <h3 className="text-lg font-semibold">Tải của nhóm tôi</h3>
          {myLoads.length === 0 && <p className="text-slate-600">Chưa đăng tải nào.</p>}
          {myLoads.map((l) => (
            <MyLoadCard key={l.id} load={l} carriers={carriers} onChanged={data.reload} />
          ))}
        </Card>
      )}
      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Tải đang tìm xe (thấy được theo mức hiển thị)</h3>
        <SelfDeclaredNote />
        <p className="text-slate-600">
          Danh sách rút gọn trước khi chốt: chỉ thấy tỉnh đi/đến và khung giờ. Địa chỉ chi tiết và số điện thoại chỉ hiện
          sau khi hai bên chốt chuyến. Ở T1, chủ hàng là phía chủ động chỉ định nhà xe; chào giá cạnh tranh thuộc giai
          đoạn sau.
        </p>
        {othersLoads.length === 0 && <p className="text-slate-600">Chưa có tải nào đang mở mà nhóm bạn thấy được.</p>}
        {othersLoads.map((l) => (
          <PublicLoadRow key={l.id} load={l} highlight={isCarrier && l.shipper_group_id !== ctx.groupId} />
        ))}
      </Card>
    </div>
  )
}

function CreateLoadForm({
  ctx,
  orders,
  warehouses,
  carriers,
  onCreated,
}: {
  ctx: FreightCtx
  orders: Awaited<ReturnType<typeof listGroupOrders>>
  warehouses: Awaited<ReturnType<typeof listWarehouses>>
  carriers: OrgProfile[]
  onCreated: () => void
}) {
  const [orderId, setOrderId] = useState('')
  const [goods, setGoods] = useState('')
  const [weight, setWeight] = useState('')
  const [packages, setPackages] = useState('')
  const [volume, setVolume] = useState('')
  const [vehicleType, setVehicleType] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [pickupAddress, setPickupAddress] = useState('')
  const [pickupProvince, setPickupProvince] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [deliveryProvince, setDeliveryProvince] = useState('')
  const [deliveryName, setDeliveryName] = useState('')
  const [deliveryPhone, setDeliveryPhone] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [deliveryTo, setDeliveryTo] = useState('')
  const [visibility, setVisibility] = useState<LoadVisibility>('NETWORK')
  const [directed, setDirected] = useState('')
  const [asking, setAsking] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  function pickOrder(id: string) {
    setOrderId(id)
    const o = orders.find((x) => x.id === id)
    if (!o) return
    setGoods(o.goods)
    setWeight(o.weight_kg ? String(o.weight_kg) : '')
    setPackages(o.packages ? String(o.packages) : '')
    setPickupAddress(o.pickup_address ?? '')
    setDeliveryAddress(o.delivery_address ?? '')
  }

  async function submit() {
    setErr('')
    setMsg('')
    const wh = warehouses.find((w) => w.id === warehouseId)
    const effPickupAddress = strOrNull(pickupAddress) ?? wh?.address ?? null
    const v = validateLoadInput({
      goods_desc: goods,
      weight_kg: numOrNull(weight),
      packages: numOrNull(packages),
      volume_m3: numOrNull(volume),
      pickup_address: effPickupAddress,
      delivery_address: strOrNull(deliveryAddress),
      pickup_window_from: localToIso(from),
      pickup_window_to: localToIso(to),
      visibility,
      directed_group_id: directed || null,
      asking_price: numOrNull(asking),
    })
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    const order = orders.find((x) => x.id === orderId)
    setBusy(true)
    try {
      const load = await createLoad({
        groupId: ctx.groupId,
        orderId: orderId || null,
        shipmentCode: order?.shipment_code ?? null,
        goodsDesc: goods.trim(),
        weightKg: numOrNull(weight),
        packages: numOrNull(packages),
        volumeM3: numOrNull(volume),
        vehicleTypeRequired: strOrNull(vehicleType),
        pickupWarehouseId: warehouseId || null,
        pickupAddress: effPickupAddress,
        pickupProvince: strOrNull(pickupProvince) ?? wh?.province ?? null,
        deliveryAddress: strOrNull(deliveryAddress),
        deliveryProvince: strOrNull(deliveryProvince),
        deliveryContactName: strOrNull(deliveryName),
        deliveryContactPhone: strOrNull(deliveryPhone),
        pickupWindowFrom: localToIso(from),
        pickupWindowTo: localToIso(to),
        deliveryWindowTo: localToIso(deliveryTo),
        visibility,
        directedGroupId: visibility === 'DIRECT' ? directed : null,
        askingPrice: numOrNull(asking),
      })
      setMsg(`Đã đăng tải ${load.code} — đang tìm xe.`)
      setGoods('')
      setOrderId('')
      onCreated()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3">
      <h3 className="text-lg font-semibold">Đăng tải tìm xe</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tạo từ đơn có sẵn (không bắt buộc)">
          <select className={inputClass} value={orderId} onChange={(e) => pickOrder(e.target.value)}>
            <option value="">— Tải độc lập —</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>{o.code} · {o.goods}</option>
            ))}
          </select>
        </Field>
        <Field label="Mô tả hàng *">
          <input className={inputClass} value={goods} onChange={(e) => setGoods(e.target.value)} placeholder="VD: Hàng tiêu dùng đóng thùng" />
        </Field>
        <Field label="Tổng kg">
          <input className={inputClass} value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Số kiện">
          <input className={inputClass} value={packages} onChange={(e) => setPackages(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Thể tích (m³)">
          <input className={inputClass} value={volume} onChange={(e) => setVolume(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Loại xe cần">
          <input className={inputClass} value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} placeholder="VD: Tải thùng 5 tấn" />
        </Field>
        <Field label="Kho lấy hàng (hồ sơ kho)">
          <select className={inputClass} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">— Địa chỉ tự nhập bên dưới —</option>
            {warehouses.filter((w) => w.active).map((w) => (
              <option key={w.id} value={w.id}>{w.name} — {w.address}</option>
            ))}
          </select>
        </Field>
        <Field label="Địa chỉ lấy (nếu không chọn kho)">
          <input className={inputClass} value={pickupAddress} onChange={(e) => setPickupAddress(e.target.value)} />
        </Field>
        <Field label="Tỉnh lấy">
          <input className={inputClass} value={pickupProvince} onChange={(e) => setPickupProvince(e.target.value)} />
        </Field>
        <Field label="Địa chỉ giao">
          <input className={inputClass} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} />
        </Field>
        <Field label="Tỉnh giao">
          <input className={inputClass} value={deliveryProvince} onChange={(e) => setDeliveryProvince(e.target.value)} />
        </Field>
        <Field label="Người nhận">
          <input className={inputClass} value={deliveryName} onChange={(e) => setDeliveryName(e.target.value)} />
        </Field>
        <Field label="Điện thoại người nhận">
          <input className={inputClass} value={deliveryPhone} onChange={(e) => setDeliveryPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Lấy hàng từ">
          <input type="datetime-local" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Lấy hàng đến">
          <input type="datetime-local" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Giao chậm nhất">
          <input type="datetime-local" className={inputClass} value={deliveryTo} onChange={(e) => setDeliveryTo(e.target.value)} />
        </Field>
        <Field label="Mức hiển thị">
          <select className={inputClass} value={visibility} onChange={(e) => setVisibility(e.target.value as LoadVisibility)}>
            {(Object.keys(LOAD_VISIBILITY_LABELS) as LoadVisibility[]).map((v) => (
              <option key={v} value={v}>{LOAD_VISIBILITY_LABELS[v]}</option>
            ))}
          </select>
        </Field>
        {visibility === 'DIRECT' && (
          <Field label="Chỉ định nhà xe *">
            <select className={inputClass} value={directed} onChange={(e) => setDirected(e.target.value)}>
              <option value="">— Chọn nhà xe —</option>
              {carriers.map((c) => (
                <option key={c.group_id} value={c.group_id}>{c.display_name} ({ORG_TYPE_LABELS[c.org_type]})</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Giá mong muốn (đ)">
          <input className={inputClass} value={asking} onChange={(e) => setAsking(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      <Button onClick={submit} disabled={busy || goods.trim() === ''}>{busy ? 'Đang đăng…' : 'Đăng tải'}</Button>
    </Card>
  )
}

function MyLoadCard({ load, carriers, onChanged }: { load: FreightLoad; carriers: OrgProfile[]; onChanged: () => void }) {
  const [carrier, setCarrier] = useState(load.directed_group_id ?? '')
  const [price, setPrice] = useState(load.asking_price?.toString() ?? '')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function assign() {
    setErr('')
    setMsg('')
    if (!carrier) {
      setErr('Hãy chọn nhà xe để chỉ định.')
      return
    }
    setBusy(true)
    try {
      const b = await assignBooking(load.id, carrier, numOrNull(price))
      setMsg(`Đã chỉ định — chuyến ${b.code} đang chờ nhà xe xác nhận.`)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setErr('')
    setBusy(true)
    try {
      await cancelLoad(load.id, strOrNull(reason))
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  const open = load.status === 'POSTED'
  const cancellable = load.status === 'POSTED' || load.status === 'ASSIGNED'

  return (
    <div className="space-y-2 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{load.code}</span>
        <span className="font-medium">{load.goods_desc}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{LOAD_STATUS_LABELS[load.status]}</span>
        <span className="text-slate-600">{LOAD_VISIBILITY_LABELS[load.visibility]}</span>
        {load.asking_price != null && <span className="text-slate-600">Giá mong muốn {fmtMoney(load.asking_price)}</span>}
      </div>
      <p className="text-slate-600">
        {load.pickup_province ?? load.pickup_address ?? '—'} → {load.delivery_province ?? load.delivery_address ?? '—'}
        {load.weight_kg ? ` · ${load.weight_kg} kg` : ''}{load.packages ? ` · ${load.packages} kiện` : ''}
        {load.pickup_window_from ? ` · Lấy từ ${fmtDateTime(load.pickup_window_from)}` : ''}
      </p>
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      {open && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Field label="Chỉ định nhà xe">
              <select className={inputClass} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">— Chọn nhà xe —</option>
                {carriers.map((c) => (
                  <option key={c.group_id} value={c.group_id}>{c.display_name}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Giá chốt (đ)">
              <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          <Button onClick={assign} disabled={busy}>Chỉ định nhà xe</Button>
        </div>
      )}
      {cancellable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Field label="Lý do huỷ tải (không bắt buộc)">
              <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <Button kind="secondary" onClick={cancel} disabled={busy}>Huỷ tải</Button>
        </div>
      )}
    </div>
  )
}

function PublicLoadRow({ load, highlight }: { load: PublicLoad; highlight: boolean }) {
  return (
    <div className="space-y-1 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{load.code}</span>
        <span className="font-medium">{load.goods_desc}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{LOAD_STATUS_LABELS[load.status]}</span>
        <span className="text-slate-600">{LOAD_VISIBILITY_LABELS[load.visibility]}</span>
        {load.asking_price != null && <span className="text-slate-600">Giá mong muốn {fmtMoney(load.asking_price)}</span>}
      </div>
      <p className="text-slate-600">
        Chủ hàng: {load.shipper_display_name ?? '—'} · {load.pickup_province ?? '—'} → {load.delivery_province ?? '—'}
        {load.weight_kg ? ` · ${load.weight_kg} kg` : ''}{load.packages ? ` · ${load.packages} kiện` : ''}
        {load.vehicle_type_required ? ` · Cần xe: ${load.vehicle_type_required}` : ''}
        {load.pickup_window_from ? ` · Lấy từ ${fmtDateTime(load.pickup_window_from)}` : ''}
      </p>
      {highlight && <p className="text-slate-500">Nếu phù hợp, hãy liên hệ chủ hàng hoặc chờ được chỉ định — chào giá trực tiếp trên tải thuộc giai đoạn sau (T2).</p>}
    </div>
  )
}
