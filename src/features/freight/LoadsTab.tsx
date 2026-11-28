import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import { FormDialog } from '../../shared/ui/FormDialog'
import { promptText } from '../../shared/ui/Dialog'
import {
  assignBookingAcct,
  cancelLoadAcct,
  createLoadAcct,
  freightAcctErrText,
  listAccountDirectory,
  listDiscoverLoads,
  listLoadShares,
  listMyAccountLinks,
  listMyAcctLoads,
  listMyWarehouses,
  shareLoadToGroup,
  unshareLoad,
  type AccountProfile,
  type AcctLoad,
  type DiscoverLoad,
} from '../../shared/supabase/freightAccount'
import { listGroupOrders, listMyGroups, type GroupOrderLite } from '../../shared/supabase/freight'
import { LOAD_STATUS_LABELS, LOAD_VISIBILITY_LABELS, validateLoadInput, type LoadVisibility } from '../../domain/freight/load'
import { linkedAccountIds } from '../../domain/freight/account'
import { SelfDeclaredNote, fmtDateTime, fmtMoney, localToIso, numOrNull, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightAcctErrText(e))
  })

export default function LoadsTab({ ctx }: { ctx: FreightCtx }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          listMyAcctLoads(ctx.me),
          listDiscoverLoads(),
          listAccountDirectory({ onlyCarriers: true }),
          listMyAccountLinks(ctx.me),
          listMyWarehouses(ctx.me),
        ]),
      ),
    [ctx.me],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải…</p>
  const [myLoads, discover, carriers, links, warehouses] = data.data
  const linked = linkedAccountIds(links, ctx.me)
  const others = discover.filter((l) => l.poster_account_id !== ctx.me)
  const filtered = others.filter(
    (l) =>
      (!fromFilter || (l.pickup_province ?? '').toLowerCase().includes(fromFilter.toLowerCase())) &&
      (!toFilter || (l.delivery_province ?? '').toLowerCase().includes(toFilter.toLowerCase())),
  )

  return (
    <div className="space-y-4">
      {ctx.account.is_shipper ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">Tải của tôi</h3>
            <span className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>Đăng tải mới</Button>
            </span>
          </div>
          {myLoads.length === 0 && <p className="text-slate-600">Chưa đăng tải nào — bấm “Đăng tải mới” để tạo.</p>}
          {myLoads.map((l) => (
            <MyLoadCard key={l.id} load={l} carriers={carriers} linkedIds={linked} onChanged={data.reload} />
          ))}
        </Card>
      ) : (
        <Notice>Bạn chưa đăng ký vai trò Chủ kho nên chưa đăng tải được. Bật vai trò ở tab “Đăng ký của tôi”.</Notice>
      )}

      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Tải đang tìm xe</h3>
        <SelfDeclaredNote />
        <p className="text-slate-600">
          Danh sách rút gọn trước khi chốt: chỉ thấy tỉnh đi/đến và khung giờ. Địa chỉ chi tiết và số điện thoại chỉ
          hiện sau khi hai bên chốt chuyến. Chủ hàng là phía chủ động chỉ định nhà xe; chào giá cạnh tranh thuộc giai
          đoạn sau (T2).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lọc tỉnh lấy">
            <input className={inputClass} value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} />
          </Field>
          <Field label="Lọc tỉnh giao">
            <input className={inputClass} value={toFilter} onChange={(e) => setToFilter(e.target.value)} />
          </Field>
        </div>
        {filtered.length === 0 && <p className="text-slate-600">Chưa có tải nào đang mở mà tài khoản bạn thấy được.</p>}
        {filtered.map((l) => (
          <DiscoverRow key={l.id} load={l} directedToMe={l.visibility === 'DIRECT'} />
        ))}
      </Card>

      {createOpen && (
        <CreateLoadDialog
          warehouses={warehouses}
          carriers={carriers}
          linkedIds={linked}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            data.reload()
          }}
        />
      )}
    </div>
  )
}

// ----- Ô tìm/chọn nhà xe theo TÀI KHOẢN (dùng chung cho đăng tải + chỉ định) -----

export function CarrierPicker({
  carriers,
  linkedIds,
  value,
  onChange,
}: {
  carriers: AccountProfile[]
  linkedIds: string[]
  value: string
  onChange: (accountId: string) => void
}) {
  const [q, setQ] = useState('')
  const selected = carriers.find((c) => c.account_id === value)
  const query = q.trim().toLowerCase()
  const matches = carriers
    .filter(
      (c) =>
        query === '' ||
        c.display_name.toLowerCase().includes(query) ||
        (c.contact_phone ?? '').replace(/\s/g, '').includes(query.replace(/\s/g, '')),
    )
    .sort((a, b) => Number(linkedIds.includes(b.account_id)) - Number(linkedIds.includes(a.account_id)))
    .slice(0, 8)
  return (
    <div className="space-y-2">
      <input
        className={inputClass}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Tìm nhà xe theo tên hoặc SĐT…"
        aria-label="Tìm nhà xe"
      />
      {selected && (
        <p className="text-slate-600">
          Đã chọn: <span className="font-medium text-slate-800">{selected.display_name}</span>
          {selected.province ? ` · ${selected.province}` : ''}
          {selected.contact_phone ? ` · ${selected.contact_phone}` : ''}{' '}
          <Button kind="secondary" onClick={() => onChange('')}>Bỏ chọn</Button>
        </p>
      )}
      {!selected &&
        matches.map((c) => (
          <div key={c.account_id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
            <span className="font-medium">{c.display_name}</span>
            <span className="text-slate-600">
              {c.province ?? ''}
              {c.contact_phone ? ` · ${c.contact_phone}` : ''}
              {linkedIds.includes(c.account_id) ? ' · Đã kết nối' : ''}
            </span>
            <span className="ml-auto">
              <Button kind="secondary" onClick={() => onChange(c.account_id)}>Chọn nhà xe này</Button>
            </span>
          </div>
        ))}
      {!selected && matches.length === 0 && (
        <p className="text-slate-500">Không có nhà xe nào khớp. Chỉ chỉ định được cho nhà xe đã có tài khoản và đã đăng ký vận tải trên hệ thống.</p>
      )}
    </div>
  )
}

// ----- Dialog đăng tải -----

function CreateLoadDialog({
  warehouses,
  carriers,
  linkedIds,
  onClose,
  onCreated,
}: {
  warehouses: Awaited<ReturnType<typeof listMyWarehouses>>
  carriers: AccountProfile[]
  linkedIds: string[]
  onClose: () => void
  onCreated: () => void
}) {
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
  const [expires, setExpires] = useState('')
  const [visibility, setVisibility] = useState<LoadVisibility>('NETWORK')
  const [directed, setDirected] = useState('')
  const [asking, setAsking] = useState('')
  const [sourceGroupId, setSourceGroupId] = useState('')
  const [orderId, setOrderId] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const groups = useLoad(() => wrap(listMyGroups()), [])
  const orders = useLoad(
    async () => (sourceGroupId ? wrap(listGroupOrders(sourceGroupId)) : ([] as GroupOrderLite[])),
    [sourceGroupId],
  )

  function pickOrder(id: string) {
    setOrderId(id)
    const o = (orders.data ?? []).find((x) => x.id === id)
    if (!o) return
    setGoods(o.goods)
    setWeight(o.weight_kg ? String(o.weight_kg) : '')
    setPackages(o.packages ? String(o.packages) : '')
    setPickupAddress(o.pickup_address ?? '')
    setDeliveryAddress(o.delivery_address ?? '')
  }

  async function submit() {
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
      directed_account_id: directed || null,
      asking_price: numOrNull(asking),
    })
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    const order = (orders.data ?? []).find((x) => x.id === orderId)
    setBusy(true)
    setErr('')
    try {
      await createLoadAcct({
        sourceGroupId: sourceGroupId || null,
        orderId: orderId || null,
        shipmentCode: order?.shipment_code ?? null,
        goodsDesc: goods.trim(),
        weightKg: numOrNull(weight),
        packages: numOrNull(packages),
        volumeM3: numOrNull(volume),
        vehicleTypeRequired: strOrNull(vehicleType),
        pickupPointId: warehouseId || null,
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
        directedAccountId: visibility === 'DIRECT' ? directed : null,
        askingPrice: numOrNull(asking),
        expiresAt: localToIso(expires),
      })
      onCreated()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title="Đăng tải tìm xe" onClose={onClose} onSubmit={submit} submitText="Đăng tải" busy={busy} error={err} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mô tả hàng *">
          <input className={inputClass} value={goods} onChange={(e) => setGoods(e.target.value)} placeholder="VD: Hàng tiêu dùng đóng thùng" />
        </Field>
        <Field label="Loại xe cần">
          <input className={inputClass} value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} placeholder="VD: Tải thùng 5 tấn" />
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
        <Field label="Giá mong muốn (đ)">
          <input className={inputClass} value={asking} onChange={(e) => setAsking(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Điểm lấy hàng — Kho của tôi">
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
        <Field label="Đăng đến (hạn đăng, không bắt buộc)">
          <input type="datetime-local" className={inputClass} value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label="Mức hiển thị">
          <select className={inputClass} value={visibility} onChange={(e) => setVisibility(e.target.value as LoadVisibility)}>
            {(Object.keys(LOAD_VISIBILITY_LABELS) as LoadVisibility[]).map((v) => (
              <option key={v} value={v}>{LOAD_VISIBILITY_LABELS[v]}</option>
            ))}
          </select>
        </Field>
      </div>
      {visibility === 'DIRECT' && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Chỉ định nhà xe *</p>
          <CarrierPicker carriers={carriers} linkedIds={linkedIds} value={directed} onChange={setDirected} />
        </div>
      )}
      <details className="rounded-lg bg-slate-50 p-3">
        <summary className="cursor-pointer font-medium">Tạo từ đơn trong group (không bắt buộc)</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Group nguồn">
            <select className={inputClass} value={sourceGroupId} onChange={(e) => { setSourceGroupId(e.target.value); setOrderId('') }}>
              <option value="">— Tải độc lập, không qua group —</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Đơn trong group">
            <select className={inputClass} value={orderId} disabled={!sourceGroupId} onChange={(e) => pickOrder(e.target.value)}>
              <option value="">— Không gắn đơn —</option>
              {(orders.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.code} · {o.goods}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-slate-500">
          Gắn đơn chỉ để đồng bộ trạng thái chuyến về đơn đó và để hai bên đối chiếu — quyền sở hữu tải vẫn là tài
          khoản của bạn, xoá group không xoá tải này.
        </p>
      </details>
    </FormDialog>
  )
}

// ----- Thẻ tải của tôi + chỉ định + chia sẻ + huỷ -----

function MyLoadCard({
  load,
  carriers,
  linkedIds,
  onChanged,
}: {
  load: AcctLoad
  carriers: AccountProfile[]
  linkedIds: string[]
  onChanged: () => void
}) {
  const [assignOpen, setAssignOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [err, setErr] = useState('')
  const open = load.status === 'POSTED'
  const cancellable = load.status === 'POSTED' || load.status === 'ASSIGNED'

  async function cancel() {
    const reason = await promptText(`Huỷ tải ${load.code}? Nhập lý do (có thể để trống rồi bấm Đồng ý):`)
    if (reason === null) return
    setErr('')
    try {
      await cancelLoadAcct(load.id, reason.trim() === '' ? null : reason.trim())
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }

  return (
    <div className="space-y-2 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{load.code}</span>
        <span className="font-medium">{load.goods_desc}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{LOAD_STATUS_LABELS[load.status]}</span>
        <span className="text-slate-600">{LOAD_VISIBILITY_LABELS[load.visibility]}</span>
        {load.asking_price != null && <span className="text-slate-600">Giá mong muốn {fmtMoney(load.asking_price)}</span>}
        {load.order_id && <span className="text-slate-500">· Có gắn đơn trong group</span>}
      </div>
      <p className="text-slate-600">
        {load.pickup_province ?? load.pickup_address ?? '—'} → {load.delivery_province ?? load.delivery_address ?? '—'}
        {load.weight_kg ? ` · ${load.weight_kg} kg` : ''}
        {load.packages ? ` · ${load.packages} kiện` : ''}
        {load.pickup_window_from ? ` · Lấy từ ${fmtDateTime(load.pickup_window_from)}` : ''}
        {load.expires_at ? ` · Đăng đến ${fmtDateTime(load.expires_at)}` : ''}
      </p>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap gap-2">
        {open && <Button onClick={() => setAssignOpen(true)}>Chỉ định nhà xe</Button>}
        {(open || load.status === 'ASSIGNED' || load.status === 'BOOKED') && (
          <Button kind="secondary" onClick={() => setShareOpen(true)}>Chia sẻ vào group</Button>
        )}
        {cancellable && (
          <Button kind="secondary" onClick={cancel}>Huỷ tải</Button>
        )}
      </div>
      {assignOpen && (
        <AssignDialog
          load={load}
          carriers={carriers}
          linkedIds={linkedIds}
          onClose={() => setAssignOpen(false)}
          onDone={() => {
            setAssignOpen(false)
            onChanged()
          }}
        />
      )}
      {shareOpen && (
        <ShareDialog
          load={load}
          onClose={() => setShareOpen(false)}
          onDone={() => {
            setShareOpen(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

function AssignDialog({
  load,
  carriers,
  linkedIds,
  onClose,
  onDone,
}: {
  load: AcctLoad
  carriers: AccountProfile[]
  linkedIds: string[]
  onClose: () => void
  onDone: () => void
}) {
  const [carrier, setCarrier] = useState(load.directed_account_id ?? '')
  const [price, setPrice] = useState(load.asking_price?.toString() ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!carrier) {
      setErr('Hãy chọn một nhà xe để chỉ định.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await assignBookingAcct(load.id, carrier, numOrNull(price))
      onDone()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={`Chỉ định nhà xe — tải ${load.code}`} onClose={onClose} onSubmit={submit} submitText="Chỉ định" busy={busy} error={err} wide>
      <SelfDeclaredNote />
      <CarrierPicker carriers={carriers} linkedIds={linkedIds} value={carrier} onChange={setCarrier} />
      <Field label="Giá thoả thuận (đ, không bắt buộc)">
        <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
      </Field>
      <p className="text-slate-500">
        Nhà xe sẽ thấy chuyến ở tab “Chuyến của tôi” của họ và xác nhận hoặc từ chối. Chỉ định chính tài khoản của
        bạn (tự vận chuyển) cũng được.
      </p>
    </FormDialog>
  )
}

function ShareDialog({ load, onClose, onDone }: { load: AcctLoad; onClose: () => void; onDone: () => void }) {
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState('')
  const data = useLoad(
    () =>
      wrap(
        Promise.all([listMyGroups(), listLoadShares(load.id)]).then(([groups, shares]) => ({ groups, shares })),
      ),
    [load.id],
  )
  if (!data.data) {
    return (
      <FormDialog title={`Chia sẻ tải ${load.code} vào group`} onClose={onClose}>
        <p className="text-slate-600">{data.error ?? 'Đang tải…'}</p>
      </FormDialog>
    )
  }
  const { groups, shares } = data.data
  const sharedIds = new Set(shares.map((s) => s.group_id))

  async function toggle(groupId: string, shared: boolean) {
    setBusyId(groupId)
    setErr('')
    try {
      if (shared) await unshareLoad(load.id, groupId)
      else await shareLoadToGroup(load.id, groupId)
      data.reload()
    } catch (e) {
      setErr(freightAcctErrText(e))
    } finally {
      setBusyId('')
    }
  }

  return (
    <FormDialog title={`Chia sẻ tải ${load.code} vào group`} onClose={onClose} error={err}>
      <p className="text-slate-600">
        Thành viên group được chia sẻ sẽ thấy bản rút gọn của tải này trong không gian trao đổi. Giá chốt và chi
        tiết chuyến không hiển thị cho group. Bấm “Xong” khi đã chọn xong.
      </p>
      {groups.length === 0 && <p className="text-slate-600">Bạn chưa thuộc group nào.</p>}
      {groups.map((g) => {
        const shared = sharedIds.has(g.id)
        return (
          <div key={g.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
            <span className="font-medium">{g.name}</span>
            <span className="ml-auto">
              <Button kind="secondary" disabled={busyId === g.id} onClick={() => toggle(g.id, shared)}>
                {shared ? 'Bỏ chia sẻ' : 'Chia sẻ vào group này'}
              </Button>
            </span>
          </div>
        )
      })}
      <div className="flex justify-end">
        <Button kind="primary" onClick={onDone}>Xong</Button>
      </div>
    </FormDialog>
  )
}

function DiscoverRow({ load, directedToMe }: { load: DiscoverLoad; directedToMe: boolean }) {
  return (
    <div className="space-y-1 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{load.code}</span>
        <span className="font-medium">{load.goods_desc}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{LOAD_STATUS_LABELS[load.status]}</span>
        <span className="text-slate-600">{LOAD_VISIBILITY_LABELS[load.visibility]}</span>
        {load.asking_price != null && <span className="text-slate-600">Giá mong muốn {fmtMoney(load.asking_price)}</span>}
        {directedToMe && <span className="font-medium text-brand-700">Được chỉ định cho bạn</span>}
      </div>
      <p className="text-slate-600">
        Chủ hàng: {load.poster_display_name ?? '—'} · {load.pickup_province ?? '—'} → {load.delivery_province ?? '—'}
        {load.weight_kg ? ` · ${load.weight_kg} kg` : ''}
        {load.packages ? ` · ${load.packages} kiện` : ''}
        {load.vehicle_type_required ? ` · Cần xe: ${load.vehicle_type_required}` : ''}
        {load.pickup_window_from ? ` · Lấy từ ${fmtDateTime(load.pickup_window_from)}` : ''}
        {load.expires_at ? ` · Đăng đến ${fmtDateTime(load.expires_at)}` : ''}
      </p>
      {directedToMe && (
        <p className="text-slate-500">Nếu chủ hàng đã gửi chỉ định, chuyến chờ xác nhận nằm ở tab “Chuyến của tôi”.</p>
      )}
    </div>
  )
}
