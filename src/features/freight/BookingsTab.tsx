import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import { FormDialog } from '../../shared/ui/FormDialog'
import { promptText } from '../../shared/ui/Dialog'
import {
  advanceBookingAcct,
  assignMyVehicleDriver,
  cancelBookingAcct,
  freightAcctErrText,
  listAccountDirectory,
  listBookingsAsCarrierAcct,
  listBookingsAsDriverAcct,
  listBookingsAsShipperAcct,
  listMyDriverCarrierIds,
  listMyDrivers,
  listMyVehicles,
  respondBookingAcct,
  type AcctBooking,
  type MyDriver,
  type MyVehicle,
} from '../../shared/supabase/freightAccount'
import { getLoadById, listBookingEvents, type BookingEvent, type FreightLoad } from '../../shared/supabase/freight'
import {
  BOOKING_STATUS_LABELS,
  bookingActionsFor,
  type BookingSide,
  type BookingStatus,
} from '../../domain/freight/booking'
import { accountActorSide } from '../../domain/freight/account'
import { SelfDeclaredNote, fmtDate, fmtDateTime, fmtMoney, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightAcctErrText(e))
  })

interface BookingBundle {
  booking: AcctBooking
  load: FreightLoad | null
}

export default function BookingsTab({ ctx }: { ctx: FreightCtx }) {
  const data = useLoad(
    () =>
      wrap(
        (async () => {
          const driverCarrierIds = await listMyDriverCarrierIds(ctx.me).catch(() => [] as string[])
          const [asShipper, asCarrier, asDriver, directory, myVehicles, myDrivers] = await Promise.all([
            listBookingsAsShipperAcct(ctx.me),
            listBookingsAsCarrierAcct(ctx.me),
            listBookingsAsDriverAcct(driverCarrierIds),
            listAccountDirectory(),
            listMyVehicles(ctx.me),
            listMyDrivers(ctx.me),
          ])
          const byId = new Map<string, AcctBooking>()
          for (const b of [...asShipper, ...asCarrier, ...asDriver]) byId.set(b.id, b)
          const all = [...byId.values()]
          const loadIds = [...new Set(all.map((b) => b.load_id))]
          const loads = new Map<string, FreightLoad | null>()
          await Promise.all(
            loadIds.map(async (id) => {
              loads.set(id, await getLoadById(id).catch(() => null))
            }),
          )
          const bundles: BookingBundle[] = all.map((booking) => ({ booking, load: loads.get(booking.load_id) ?? null }))
          return { bundles, directory, myVehicles, myDrivers, driverCarrierIds }
        })(),
      ),
    [ctx.me],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải chuyến…</p>
  const { bundles, directory, myVehicles, myDrivers, driverCarrierIds } = data.data
  const nameOf = (accountId: string | null) =>
    (accountId && directory.find((p) => p.account_id === accountId)?.display_name) || (accountId ? accountId.slice(0, 8) : '—')
  const sideOf = (b: AcctBooking): BookingSide | null =>
    accountActorSide(ctx.me, b.shipper_account_id, b.carrier_account_id, driverCarrierIds)

  const mine = bundles.filter((x) => x.booking.shipper_account_id === ctx.me)
  const carrying = bundles.filter((x) => x.booking.shipper_account_id !== ctx.me)

  return (
    <div className="space-y-4">
      <SelfDeclaredNote />
      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Chuyến tôi là chủ hàng</h3>
        {mine.length === 0 && <p className="text-slate-600">Chưa có chuyến nào.</p>}
        {mine.map((x) => (
          <BookingCard
            key={x.booking.id}
            bundle={x}
            side={sideOf(x.booking) ?? 'SHIPPER'}
            counterpartyName={nameOf(x.booking.carrier_account_id)}
            counterpartyLabel="Nhà xe"
            myVehicles={myVehicles}
            myDrivers={myDrivers}
            onChanged={data.reload}
          />
        ))}
      </Card>
      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Chuyến tôi là nhà xe / tài xế</h3>
        {carrying.length === 0 && <p className="text-slate-600">Chưa có chuyến nào.</p>}
        {carrying.map((x) => (
          <BookingCard
            key={x.booking.id}
            bundle={x}
            side={sideOf(x.booking) ?? 'CARRIER'}
            counterpartyName={nameOf(x.booking.shipper_account_id)}
            counterpartyLabel="Chủ hàng"
            myVehicles={myVehicles}
            myDrivers={myDrivers}
            onChanged={data.reload}
          />
        ))}
      </Card>
    </div>
  )
}

const EVENT_LABELS: Record<string, string> = {
  ASSIGNED: 'Chủ hàng chỉ định nhà xe',
  ACCEPTED: 'Nhà xe chấp nhận chuyến',
  DECLINED: 'Nhà xe từ chối chuyến',
  VEHICLE_DRIVER_ASSIGNED: 'Đã gán xe / tài xế',
  CREATED: 'Tạo chuyến',
  NOTE: 'Ghi chú',
}

function eventLabel(e: BookingEvent): string {
  if (e.event_type in BOOKING_STATUS_LABELS) return BOOKING_STATUS_LABELS[e.event_type as BookingStatus]
  return EVENT_LABELS[e.event_type] ?? e.event_type
}

function BookingCard({
  bundle,
  side,
  counterpartyName,
  counterpartyLabel,
  myVehicles,
  myDrivers,
  onChanged,
}: {
  bundle: BookingBundle
  side: BookingSide
  counterpartyName: string
  counterpartyLabel: string
  myVehicles: MyVehicle[]
  myDrivers: MyDriver[]
  onChanged: () => void
}) {
  const b = bundle.booking
  const load = bundle.load
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [vdOpen, setVdOpen] = useState(false)
  const events = useLoad(
    async () => (showEvents ? wrap(listBookingEvents(b.id)) : ([] as BookingEvent[])),
    [showEvents, b.id],
  )

  const actions = bookingActionsFor(b.status, side)
  const selfHaul = !!b.shipper_account_id && b.shipper_account_id === b.carrier_account_id
  // Gán xe/tài xế CỦA TÔI: chỉ phía nhà xe (tài khoản carrier là tôi,
  // gồm cả tự vận chuyển) — phía tài xế liên kết không gán thay được.
  const canAssignVD = (b.status === 'BOOKED' || b.status === 'ARRIVED_PICKUP') && (side === 'CARRIER' || selfHaul)
  const vehicle = myVehicles.find((v) => v.id === b.my_vehicle_id)
  const driver = myDrivers.find((d) => d.id === b.my_driver_id)

  async function act(to: BookingStatus) {
    setErr('')
    if (to === 'CANCELLED') {
      const reason = await promptText('Huỷ chuyến bắt buộc ghi lý do:')
      if (reason === null) return
      if (!reason.trim()) {
        setErr('Huỷ chuyến bắt buộc ghi lý do.')
        return
      }
      setBusy(true)
      try {
        await cancelBookingAcct(b.id, reason.trim())
        onChanged()
      } catch (e) {
        setErr(freightAcctErrText(e))
      } finally {
        setBusy(false)
      }
      return
    }
    setBusy(true)
    try {
      if (b.status === 'PENDING_CONFIRM' && to === 'BOOKED') await respondBookingAcct(b.id, true, strOrNull(note))
      else if (b.status === 'PENDING_CONFIRM' && to === 'DECLINED') await respondBookingAcct(b.id, false, strOrNull(note))
      else await advanceBookingAcct(b.id, to, strOrNull(note))
      setNote('')
      onChanged()
    } catch (e) {
      setErr(freightAcctErrText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{b.code}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{BOOKING_STATUS_LABELS[b.status]}</span>
        {b.price_agreed != null && <span className="text-slate-600">Giá chốt {fmtMoney(b.price_agreed)}</span>}
        <span className="text-slate-600">
          {counterpartyLabel}: <span className="font-medium text-slate-800">{counterpartyName}</span>
        </span>
        {selfHaul && <span className="text-slate-500">(tự vận chuyển)</span>}
        {side === 'DRIVER' && <span className="text-slate-500">(bạn là tài xế của chuyến này)</span>}
      </div>
      {load ? (
        <p className="text-slate-600">
          {load.goods_desc} · Lấy: {load.pickup_address ?? load.pickup_province ?? '—'} → Giao: {load.delivery_address ?? load.delivery_province ?? '—'}
          {load.delivery_contact_phone ? ` · Người nhận: ${load.delivery_contact_name ?? ''} ${load.delivery_contact_phone}` : ''}
          {load.pickup_window_from ? ` · Lấy từ ${fmtDateTime(load.pickup_window_from)}` : ''}
        </p>
      ) : (
        <p className="text-slate-500">Không đọc được thông tin tải của chuyến này.</p>
      )}
      {(b.my_vehicle_id || b.my_driver_id || b.vehicle_id || b.driver_id) && (
        <p className="text-slate-600">
          Xe: {vehicle?.plate ?? (b.my_vehicle_id || b.vehicle_id ? '—' : 'chưa gán')}
          {vehicle ? ` (đăng kiểm đến ${fmtDate(vehicle.inspection_expires_at)})` : ''} · Tài xế:{' '}
          {driver?.full_name ?? (b.my_driver_id || b.driver_id ? '—' : 'chưa gán')}
        </p>
      )}
      {b.status === 'CANCELLED' && b.cancel_reason && <p className="text-slate-600">Lý do huỷ: {b.cancel_reason}</p>}
      {err && <Notice kind="error">{err}</Notice>}

      {canAssignVD && (
        <div>
          <Button kind="secondary" onClick={() => setVdOpen(true)}>Gán xe / tài xế</Button>
        </div>
      )}
      {vdOpen && (
        <AssignVehicleDriverDialog
          booking={b}
          vehicles={myVehicles}
          drivers={myDrivers}
          onClose={() => setVdOpen(false)}
          onSaved={() => {
            setVdOpen(false)
            onChanged()
          }}
        />
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Field label="Ghi chú cho mốc này">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {actions.map((a) => (
            <Button key={a.to} kind={a.to === 'CANCELLED' || a.to === 'DECLINED' ? 'danger' : 'primary'} onClick={() => act(a.to)} disabled={busy}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {b.status === 'PENDING_CONFIRM' && side === 'SHIPPER' && (
        <p className="text-slate-500">Đang chờ nhà xe xác nhận. Muốn rút chỉ định: huỷ tải ở tab “Tìm xe / Tải”.</p>
      )}

      <Button kind="secondary" onClick={() => setShowEvents((s) => !s)}>{showEvents ? 'Ẩn dòng sự kiện' : 'Xem dòng sự kiện'}</Button>
      {showEvents && (
        <div className="space-y-1">
          {events.loading && <p className="text-slate-500">Đang tải sự kiện…</p>}
          {events.error && <Notice kind="error">{events.error}</Notice>}
          {events.data?.length === 0 && <p className="text-slate-500">Chưa có sự kiện nào.</p>}
          {events.data?.map((e) => (
            <p key={e.id} className="text-slate-600">
              <span className="font-medium text-slate-800">{eventLabel(e)}</span> · {fmtDateTime(e.created_at)}
              {e.actor_side ? ` · phía ${e.actor_side === 'SHIPPER' ? 'chủ hàng' : e.actor_side === 'DRIVER' ? 'tài xế' : 'nhà xe'}` : ''}
              {e.note ? ` · ${e.note}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function AssignVehicleDriverDialog({
  booking,
  vehicles,
  drivers,
  onClose,
  onSaved,
}: {
  booking: AcctBooking
  vehicles: MyVehicle[]
  drivers: MyDriver[]
  onClose: () => void
  onSaved: () => void
}) {
  const [vehicleId, setVehicleId] = useState(booking.my_vehicle_id ?? '')
  const [driverId, setDriverId] = useState(booking.my_driver_id ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      await assignMyVehicleDriver(booking.id, vehicleId || null, driverId || null)
      onSaved()
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog title={`Gán xe / tài xế — chuyến ${booking.code}`} onClose={onClose} onSubmit={submit} submitText="Lưu gán" busy={busy} error={err}>
      <Field label="Xe của tôi chạy chuyến này">
        <select className={inputClass} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">— Chưa gán —</option>
          {vehicles.filter((v) => v.active).map((v) => (
            <option key={v.id} value={v.id}>
              {v.plate} · {v.vehicle_type} · Đăng kiểm đến {fmtDate(v.inspection_expires_at)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tài xế của tôi">
        <select className={inputClass} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
          <option value="">— Chưa gán —</option>
          {drivers.filter((d) => d.active).map((d) => (
            <option key={d.id} value={d.id}>
              {d.full_name} · Hạn bằng đến {fmtDate(d.license_expires_at)}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-slate-500">
        Các mốc hạn giấy tờ chỉ để hiển thị cho hai bên tự đánh giá — hệ thống không chặn việc gán hay chạy chuyến
        theo các mốc này.
      </p>
    </FormDialog>
  )
}
