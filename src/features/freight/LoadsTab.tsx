import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import { FormDialog } from '../../shared/ui/FormDialog'
import { confirmDialog, promptText } from '../../shared/ui/Dialog'
import {
  acceptBid,
  assignBookingAcct,
  cancelLoadAcct,
  createLoadAcct,
  expireStale,
  freightAcctErrText,
  listAccountDirectory,
  listBidHistory,
  listBidsForLoad,
  listDiscoverLoads,
  listDriversByIds,
  listLoadShares,
  listMyAccountLinks,
  listMyAcctLoads,
  listMyDrivers,
  listMyVehicles,
  listMyWarehouses,
  listVehiclesByIds,
  listVisibleBids,
  placeBid,
  rejectBid,
  shareLoadToGroup,
  unshareLoad,
  updateBid,
  withdrawBid,
  type AccountProfile,
  type AcctBooking,
  type AcctLoad,
  type DiscoverLoad,
  type FreightBid,
} from '../../shared/supabase/freightAccount'
import { listGroupOrders, listMyGroups, type GroupOrderLite } from '../../shared/supabase/freight'
import { LOAD_STATUS_LABELS, LOAD_VISIBILITY_LABELS, validateLoadInput, type LoadVisibility } from '../../domain/freight/load'
import {
  BID_CLOSED_REASON_LABELS,
  BID_STATUS_LABELS,
  defaultBidExpiry,
  defaultOpenForBids,
  effectiveBidStatus,
  isBidLive,
  validateBidInput,
} from '../../domain/freight/bid'
import { linkedAccountIds } from '../../domain/freight/account'
import { SelfDeclaredNote, fmtDateTime, fmtMoney, isoToLocal, localToIso, numOrNull, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightAcctErrText(e))
  })

export default function LoadsTab({ ctx, onGoBookings }: { ctx: FreightCtx; onGoBookings?: () => void }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  // Quét hết hạn cơ hội phía server (đóng bid/tải quá hạn) — lỗi bỏ qua,
  // dữ liệu vẫn đúng nhờ đóng lười trong từng RPC.
  useEffect(() => {
    expireStale().catch(() => {})
  }, [])
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          listMyAcctLoads(ctx.me),
          listDiscoverLoads(),
          listAccountDirectory({ onlyCarriers: true }),
          listMyAccountLinks(ctx.me),
          listMyWarehouses(ctx.me),
          listVisibleBids(),
          listMyVehicles(ctx.me),
          listMyDrivers(ctx.me),
        ]),
      ),
    [ctx.me],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải…</p>
  const [myLoads, discover, carriers, links, warehouses, visibleBids, myVehicles, myDrivers] = data.data
  const linked = linkedAccountIds(links, ctx.me)
  const others = discover.filter((l) => l.poster_account_id !== ctx.me)
  const filtered = others.filter(
    (l) =>
      (!fromFilter || (l.pickup_province ?? '').toLowerCase().includes(fromFilter.toLowerCase())) &&
      (!toFilter || (l.delivery_province ?? '').toLowerCase().includes(toFilter.toLowerCase())),
  )
  // Bid trên tải CỦA TÔI (phía chủ tải) + bid CỦA TÔI (phía nhà xe).
  const myLoadIds = new Set(myLoads.map((l) => l.id))
  const bidsOnMyLoads = visibleBids.filter((b) => myLoadIds.has(b.load_id))
  const myBids = visibleBids.filter((b) => b.carrier_account_id === ctx.me)
  const livePendingByLoad = new Map<string, number>()
  for (const b of bidsOnMyLoads) {
    if (isBidLive(b.status, b.expires_at)) livePendingByLoad.set(b.load_id, (livePendingByLoad.get(b.load_id) ?? 0) + 1)
  }
  const totalPendingOnMine = [...livePendingByLoad.values()].reduce((a, n) => a + n, 0)
  const myLiveBidByLoad = new Map<string, FreightBid>()
  for (const b of myBids) {
    if (b.status === 'PENDING') myLiveBidByLoad.set(b.load_id, b)
  }
  const openBidLoads = filtered.filter((l) => l.open_for_bids)
  const plainLoads = filtered.filter((l) => !l.open_for_bids)
  const loadSummary = (id: string) =>
    discover.find((l) => l.id === id) ?? myLoads.find((l) => l.id === id) ?? null

  return (
    <div className="space-y-4">
      {ctx.account.is_shipper ? (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">Tải của tôi</h3>
            {totalPendingOnMine > 0 && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-800">
                Đang có {totalPendingOnMine} chào giá chờ chốt
              </span>
            )}
            <span className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>Đăng tải mới</Button>
            </span>
          </div>
          {myLoads.length === 0 && <p className="text-slate-600">Chưa đăng tải nào — bấm “Đăng tải mới” để tạo.</p>}
          {myLoads.map((l) => (
            <MyLoadCard
              key={l.id}
              load={l}
              carriers={carriers}
              linkedIds={linked}
              pendingBids={livePendingByLoad.get(l.id) ?? 0}
              onChanged={data.reload}
              onGoBookings={onGoBookings}
            />
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
          hiện sau khi hai bên chốt chuyến. Tải mở chào giá thì nhà xe đặt giá trực tiếp; các tải còn lại chờ chủ
          hàng chỉ định.
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
        {openBidLoads.length > 0 && (
          <>
            <h4 className="font-semibold text-slate-700">Đang mở chào giá</h4>
            {openBidLoads.map((l) => (
              <DiscoverRow key={l.id} load={l} directedToMe={l.visibility === 'DIRECT'}>
                {ctx.account.is_carrier ? (
                  <BidAction
                    load={l}
                    existingBid={myLiveBidByLoad.get(l.id) ?? null}
                    vehicles={myVehicles}
                    drivers={myDrivers}
                    onChanged={data.reload}
                  />
                ) : (
                  <p className="text-slate-500">Bật vai trò Vận tải ở tab “Đăng ký của tôi” để đặt chào giá.</p>
                )}
              </DiscoverRow>
            ))}
          </>
        )}
        {plainLoads.length > 0 && (
          <>
            {openBidLoads.length > 0 && <h4 className="font-semibold text-slate-700">Tải chờ chỉ định</h4>}
            {plainLoads.map((l) => (
              <DiscoverRow key={l.id} load={l} directedToMe={l.visibility === 'DIRECT'} />
            ))}
          </>
        )}
      </Card>

      {(ctx.account.is_carrier || myBids.length > 0) && (
        <MyBidsCard bids={myBids} loadSummary={loadSummary} vehicles={myVehicles} drivers={myDrivers} onChanged={data.reload} />
      )}

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

// ----- Nút đặt/sửa chào giá trên thẻ tải đang mở chào giá -----

function BidAction({
  load,
  existingBid,
  vehicles,
  drivers,
  onChanged,
}: {
  load: DiscoverLoad
  existingBid: FreightBid | null
  vehicles: Awaited<ReturnType<typeof listMyVehicles>>
  drivers: Awaited<ReturnType<typeof listMyDrivers>>
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const live = existingBid && isBidLive(existingBid.status, existingBid.expires_at)
  return (
    <div className="space-y-1">
      {live && existingBid && (
        <p className="text-slate-600">
          Bạn đã chào <span className="font-medium text-slate-800">{fmtMoney(existingBid.bid_price)}</span> · Hiệu lực
          đến {fmtDateTime(existingBid.expires_at)}
        </p>
      )}
      <Button onClick={() => setOpen(true)}>{live ? 'Sửa chào giá' : 'Đặt giá'}</Button>
      {open && (
        <BidDialog
          load={load}
          existingBid={live ? existingBid : null}
          vehicles={vehicles}
          drivers={drivers}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

// ----- Dialog đặt / sửa chào giá (phía nhà xe) -----

function BidDialog({
  load,
  existingBid,
  vehicles,
  drivers,
  onClose,
  onSaved,
}: {
  load: { id: string; code: string; goods_desc: string }
  existingBid: FreightBid | null
  vehicles: Awaited<ReturnType<typeof listMyVehicles>>
  drivers: Awaited<ReturnType<typeof listMyDrivers>>
  onClose: () => void
  onSaved: () => void
}) {
  const [price, setPrice] = useState(existingBid ? String(existingBid.bid_price) : '')
  const [vehicleId, setVehicleId] = useState(existingBid?.proposed_vehicle_id ?? '')
  const [driverId, setDriverId] = useState(existingBid?.proposed_driver_id ?? '')
  const [eta, setEta] = useState(isoToLocal(existingBid?.eta_pickup_at))
  const [expires, setExpires] = useState(
    existingBid ? isoToLocal(existingBid.expires_at) : isoToLocal(defaultBidExpiry().toISOString()),
  )
  const [note, setNote] = useState(existingBid?.note ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const v = validateBidInput({
      bid_price: numOrNull(price),
      expires_at: localToIso(expires),
      eta_pickup_at: localToIso(eta),
    })
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      const input = {
        bidPrice: numOrNull(price) as number,
        proposedVehicleId: vehicleId || null,
        proposedDriverId: driverId || null,
        etaPickupAt: localToIso(eta),
        note: strOrNull(note),
        expiresAt: localToIso(expires),
      }
      if (existingBid) await updateBid(existingBid.id, input)
      else await placeBid({ loadId: load.id, ...input })
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={existingBid ? `Sửa chào giá — tải ${load.code}` : `Đặt chào giá — tải ${load.code}`}
      onClose={onClose}
      onSubmit={submit}
      submitText={existingBid ? 'Lưu chào giá' : 'Gửi chào giá'}
      busy={busy}
      error={err}
    >
      <p className="text-slate-600">
        Hàng: <span className="font-medium text-slate-800">{load.goods_desc}</span>. Giá bạn chào là đề nghị gửi chủ
        tải; chủ tải chấp nhận thì chuyến được chốt ngay với đúng giá này và xe/tài xế dự kiến bên dưới.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Giá chào (đ) *">
          <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Hạn hiệu lực chào giá">
          <input type="datetime-local" className={inputClass} value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label="Xe dự kiến (của tôi)">
          <select className={inputClass} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">— Chưa chọn (gán sau) —</option>
            {vehicles.filter((v) => v.active).map((v) => (
              <option key={v.id} value={v.id}>{v.plate} — {v.vehicle_type}</option>
            ))}
          </select>
        </Field>
        <Field label="Tài xế dự kiến (của tôi)">
          <select className={inputClass} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">— Chưa chọn (gán sau) —</option>
            {drivers.filter((d) => d.active).map((d) => (
              <option key={d.id} value={d.id}>{d.full_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Giờ có thể đến lấy hàng">
          <input type="datetime-local" className={inputClass} value={eta} onChange={(e) => setEta(e.target.value)} />
        </Field>
        <Field label="Ghi chú / điều kiện">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <p className="text-slate-500">
        Mỗi tài khoản chỉ có một chào giá đang hiệu lực cho một tải — gửi lại giá mới là cập nhật chào giá hiện tại
        và hệ thống ghi lại lịch sử sửa giá cho hai bên đối chiếu.
      </p>
    </FormDialog>
  )
}

// ----- Chào giá của tôi (phía nhà xe) -----

function MyBidsCard({
  bids,
  loadSummary,
  vehicles,
  drivers,
  onChanged,
}: {
  bids: FreightBid[]
  loadSummary: (id: string) => { id: string; code: string; goods_desc: string } | null
  vehicles: Awaited<ReturnType<typeof listMyVehicles>>
  drivers: Awaited<ReturnType<typeof listMyDrivers>>
  onChanged: () => void
}) {
  const [editBid, setEditBid] = useState<FreightBid | null>(null)
  const [err, setErr] = useState('')
  const acceptedCount = bids.filter((b) => b.status === 'ACCEPTED').length

  async function withdraw(b: FreightBid) {
    if (!(await confirmDialog(`Rút chào giá ${fmtMoney(b.bid_price)} cho tải này?`))) return
    setErr('')
    try {
      await withdrawBid(b.id)
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">Chào giá của tôi</h3>
        {acceptedCount > 0 && (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-sm font-medium text-emerald-800">
            {acceptedCount} chào giá đã được chốt thành chuyến
          </span>
        )}
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      {bids.length === 0 && <p className="text-slate-600">Bạn chưa đặt chào giá nào.</p>}
      {bids.map((b) => {
        const load = loadSummary(b.load_id)
        const eff = effectiveBidStatus(b.status, b.expires_at)
        const live = isBidLive(b.status, b.expires_at)
        return (
          <div key={b.id} className="space-y-1 border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{load?.code ?? 'Tải đã đóng'}</span>
              {load && <span className="font-medium">{load.goods_desc}</span>}
              <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{BID_STATUS_LABELS[eff]}</span>
              <span className="font-medium">{fmtMoney(b.bid_price)}</span>
            </div>
            <p className="text-slate-600">
              Hiệu lực đến {fmtDateTime(b.expires_at)}
              {b.eta_pickup_at ? ` · Có thể lấy hàng ${fmtDateTime(b.eta_pickup_at)}` : ''}
              {b.closed_reason && BID_CLOSED_REASON_LABELS[b.closed_reason]
                ? ` · ${BID_CLOSED_REASON_LABELS[b.closed_reason]}`
                : b.closed_reason
                  ? ` · Lý do đóng: ${b.closed_reason}`
                  : ''}
              {b.note ? ` · ${b.note}` : ''}
            </p>
            {live && load && (
              <div className="flex flex-wrap gap-2">
                <Button kind="secondary" onClick={() => setEditBid(b)}>Sửa giá</Button>
                <Button kind="secondary" onClick={() => withdraw(b)}>Rút giá</Button>
              </div>
            )}
          </div>
        )
      })}
      {editBid && (
        <BidDialog
          load={loadSummary(editBid.load_id) ?? { id: editBid.load_id, code: '—', goods_desc: '' }}
          existingBid={editBid}
          vehicles={vehicles}
          drivers={drivers}
          onClose={() => setEditBid(null)}
          onSaved={() => {
            setEditBid(null)
            onChanged()
          }}
        />
      )}
    </Card>
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
  const [openBids, setOpenBids] = useState<boolean>(defaultOpenForBids('NETWORK'))
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
        openForBids: openBids,
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
          <select
            className={inputClass}
            value={visibility}
            onChange={(e) => {
              const v = e.target.value as LoadVisibility
              setVisibility(v)
              setOpenBids(defaultOpenForBids(v))
            }}
          >
            {(Object.keys(LOAD_VISIBILITY_LABELS) as LoadVisibility[]).map((v) => (
              <option key={v} value={v}>{LOAD_VISIBILITY_LABELS[v]}</option>
            ))}
          </select>
        </Field>
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-slate-700">
        <input type="checkbox" className="mt-1" checked={openBids} onChange={(e) => setOpenBids(e.target.checked)} />
        <span>
          {visibility === 'DIRECT' ? (
            <>
              Cho phép nhà xe được chỉ định <strong>chào giá</strong> cho tải này (thay vì chỉ chờ chỉ định). Chỉ
              đúng tài khoản được chỉ định mới đặt giá được.
            </>
          ) : (
            <>
              <strong>Mở chào giá</strong> cho tải này — nhà xe thấy được tải sẽ đặt giá trực tiếp, bạn chốt một giá
              là chuyến được tạo ngay. Tắt thì tải chỉ chờ bạn chỉ định nhà xe.
            </>
          )}
        </span>
      </label>
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
  pendingBids,
  onChanged,
  onGoBookings,
}: {
  load: AcctLoad
  carriers: AccountProfile[]
  linkedIds: string[]
  pendingBids: number
  onChanged: () => void
  onGoBookings?: () => void
}) {
  const [assignOpen, setAssignOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [bidsOpen, setBidsOpen] = useState(false)
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
        {load.open_for_bids && (
          <span className="rounded bg-sky-100 px-2 py-0.5 text-sm font-medium text-sky-800">Đang mở chào giá</span>
        )}
        {pendingBids > 0 && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-sm font-medium text-amber-800">
            Đang có {pendingBids} chào giá
          </span>
        )}
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
        {(pendingBids > 0 || (open && load.open_for_bids)) && (
          <Button kind="secondary" onClick={() => setBidsOpen(true)}>Xem chào giá{pendingBids > 0 ? ` (${pendingBids})` : ''}</Button>
        )}
        {(open || load.status === 'ASSIGNED' || load.status === 'BOOKED') && (
          <Button kind="secondary" onClick={() => setShareOpen(true)}>Chia sẻ vào group</Button>
        )}
        {cancellable && (
          <Button kind="secondary" onClick={cancel}>Huỷ tải</Button>
        )}
      </div>
      {bidsOpen && (
        <LoadBidsDialog
          load={load}
          carriers={carriers}
          onClose={() => setBidsOpen(false)}
          onChanged={onChanged}
          onGoBookings={onGoBookings}
        />
      )}
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

// ----- Dialog chi tiết tải + bảng chào giá (phía chủ tải) -----

function LoadBidsDialog({
  load,
  carriers,
  onClose,
  onChanged,
  onGoBookings,
}: {
  load: AcctLoad
  carriers: AccountProfile[]
  onClose: () => void
  onChanged: () => void
  onGoBookings?: () => void
}) {
  const [sort, setSort] = useState<'price' | 'eta'>('price')
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState('')
  const [doneBooking, setDoneBooking] = useState<AcctBooking | null>(null)
  const [historyFor, setHistoryFor] = useState<string>('')
  const [history, setHistory] = useState<Awaited<ReturnType<typeof listBidHistory>>>([])
  const data = useLoad(
    () =>
      wrap(
        (async () => {
          const bids = await listBidsForLoad(load.id)
          const vIds = [...new Set(bids.map((b) => b.proposed_vehicle_id).filter((x): x is string => !!x))]
          const dIds = [...new Set(bids.map((b) => b.proposed_driver_id).filter((x): x is string => !!x))]
          const [vehicles, drivers] = await Promise.all([listVehiclesByIds(vIds), listDriversByIds(dIds)])
          return { bids, vehicles, drivers }
        })(),
      ),
    [load.id],
  )

  async function accept(b: FreightBid) {
    const name = carriers.find((c) => c.account_id === b.carrier_account_id)?.display_name ?? 'nhà xe này'
    if (
      !(await confirmDialog(
        `Chốt chuyến với «${name}» giá ${fmtMoney(b.bid_price)}? Chuyến sẽ được tạo ngay ở trạng thái đã chốt, các chào giá khác của tải này sẽ tự đóng.`,
        { okText: 'Chấp nhận giá này' },
      ))
    )
      return
    setBusyId(b.id)
    setErr('')
    try {
      const booking = await acceptBid(b.id)
      setDoneBooking(booking)
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    } finally {
      setBusyId('')
    }
  }

  async function reject(b: FreightBid) {
    const reason = await promptText('Từ chối chào giá này? Lý do (không bắt buộc — chỉ để nhà xe biết):')
    if (reason === null) return
    setBusyId(b.id)
    setErr('')
    try {
      await rejectBid(b.id, reason.trim() === '' ? null : reason.trim())
      data.reload()
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    } finally {
      setBusyId('')
    }
  }

  async function toggleHistory(b: FreightBid) {
    if (historyFor === b.id) {
      setHistoryFor('')
      return
    }
    setHistoryFor(b.id)
    setHistory([])
    try {
      setHistory(await listBidHistory(b.id))
    } catch {
      setHistory([])
    }
  }

  if (doneBooking) {
    return (
      <FormDialog title={`Chào giá của tải ${load.code}`} onClose={onClose}>
        <Notice>
          Đã chốt chuyến <strong>{doneBooking.code}</strong> với giá {fmtMoney(doneBooking.price_agreed)} — chuyến
          đang ở trạng thái “Đã chốt chuyến”, xe/tài xế dự kiến của nhà xe đã được gán sẵn. Theo dõi và chạy chuyến
          ở tab “Chuyến của tôi”.
        </Notice>
        <div className="flex flex-wrap justify-end gap-2">
          <Button kind="secondary" onClick={onClose}>Đóng</Button>
          {onGoBookings && (
            <Button
              kind="primary"
              onClick={() => {
                onClose()
                onGoBookings()
              }}
            >
              Mở tab Chuyến của tôi
            </Button>
          )}
        </div>
      </FormDialog>
    )
  }

  const bids = [...(data.data?.bids ?? [])].sort((a, b) =>
    sort === 'price'
      ? a.bid_price - b.bid_price
      : (a.eta_pickup_at ?? '9999').localeCompare(b.eta_pickup_at ?? '9999'),
  )

  return (
    <FormDialog title={`Chào giá của tải ${load.code}`} onClose={onClose} error={err} wide>
      <p className="text-slate-600">
        {load.goods_desc} · {load.pickup_province ?? load.pickup_address ?? '—'} →{' '}
        {load.delivery_province ?? load.delivery_address ?? '—'}
        {load.asking_price != null ? ` · Giá mong muốn ${fmtMoney(load.asking_price)}` : ''}
      </p>
      <SelfDeclaredNote />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-600">Sắp xếp:</span>
        <Button kind={sort === 'price' ? 'primary' : 'secondary'} onClick={() => setSort('price')}>Giá tăng dần</Button>
        <Button kind={sort === 'eta' ? 'primary' : 'secondary'} onClick={() => setSort('eta')}>Giờ lấy sớm nhất</Button>
      </div>
      {!data.data && <p className="text-slate-600">{data.error ?? 'Đang tải…'}</p>}
      {data.data && bids.length === 0 && <p className="text-slate-600">Chưa có chào giá nào cho tải này.</p>}
      {bids.map((b) => {
        const carrier = carriers.find((c) => c.account_id === b.carrier_account_id)
        const vehicle = data.data?.vehicles.find((v) => v.id === b.proposed_vehicle_id)
        const driver = data.data?.drivers.find((d) => d.id === b.proposed_driver_id)
        const eff = effectiveBidStatus(b.status, b.expires_at)
        const live = isBidLive(b.status, b.expires_at)
        return (
          <div key={b.id} className="space-y-1 border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{carrier?.display_name ?? 'Nhà xe'}</span>
              {carrier?.province && <span className="text-slate-600">{carrier.province}</span>}
              <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{BID_STATUS_LABELS[eff]}</span>
              <span className="font-semibold">{fmtMoney(b.bid_price)}</span>
            </div>
            <p className="text-slate-600">
              {vehicle ? `Xe dự kiến: ${vehicle.plate} — ${vehicle.vehicle_type} · ` : ''}
              {driver ? `Tài xế: ${driver.full_name} · ` : ''}
              {b.eta_pickup_at ? `Có thể lấy hàng ${fmtDateTime(b.eta_pickup_at)} · ` : ''}
              Hiệu lực đến {fmtDateTime(b.expires_at)}
              {b.closed_reason && BID_CLOSED_REASON_LABELS[b.closed_reason]
                ? ` · ${BID_CLOSED_REASON_LABELS[b.closed_reason]}`
                : b.closed_reason
                  ? ` · Lý do đóng: ${b.closed_reason}`
                  : ''}
              {b.note ? ` · ${b.note}` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {live && (
                <>
                  <Button disabled={busyId === b.id} onClick={() => accept(b)}>Chấp nhận giá này</Button>
                  <Button kind="secondary" disabled={busyId === b.id} onClick={() => reject(b)}>Từ chối</Button>
                </>
              )}
              <Button kind="secondary" onClick={() => toggleHistory(b)}>
                {historyFor === b.id ? 'Ẩn lịch sử giá' : 'Lịch sử sửa giá'}
              </Button>
            </div>
            {historyFor === b.id && (
              <div className="rounded-lg bg-slate-50 p-3 text-slate-600">
                {history.length === 0 && <p>Chưa từng sửa giá — đây là giá chào ban đầu.</p>}
                {history.map((h) => (
                  <p key={h.id}>
                    {fmtDateTime(h.created_at)}: {h.old_price != null ? fmtMoney(h.old_price) : '—'} →{' '}
                    {h.new_price != null ? fmtMoney(h.new_price) : '—'}
                    {h.new_eta_pickup_at ? ` · Giờ lấy → ${fmtDateTime(h.new_eta_pickup_at)}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </FormDialog>
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

function DiscoverRow({
  load,
  directedToMe,
  children,
}: {
  load: DiscoverLoad
  directedToMe: boolean
  children?: ReactNode
}) {
  return (
    <div className="space-y-1 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{load.code}</span>
        <span className="font-medium">{load.goods_desc}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{LOAD_STATUS_LABELS[load.status]}</span>
        <span className="text-slate-600">{LOAD_VISIBILITY_LABELS[load.visibility]}</span>
        {load.open_for_bids && (
          <span className="rounded bg-sky-100 px-2 py-0.5 text-sm font-medium text-sky-800">Đang mở chào giá</span>
        )}
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
      {children}
    </div>
  )
}
