import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import {
  advanceBooking,
  assignVehicleDriver,
  cancelBooking,
  freightErrText,
  getLoadById,
  listBookingEvents,
  listBookingsAsCarrier,
  listBookingsAsShipper,
  listDrivers,
  listOrgDirectory,
  listVehicles,
  respondBooking,
  type Booking,
  type BookingEvent,
  type FreightLoad,
} from '../../shared/supabase/freight'
import {
  BOOKING_STATUS_LABELS,
  bookingActionsFor,
  type BookingSide,
  type BookingStatus,
} from '../../domain/freight/booking'
import { SelfDeclaredNote, fmtDateTime, fmtMoney, strOrNull, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightErrText(e))
  })

interface BookingBundle {
  booking: Booking
  load: FreightLoad | null
}

export default function BookingsTab({ ctx }: { ctx: FreightCtx }) {
  const data = useLoad(
    () =>
      wrap(
        (async () => {
          const [asShipper, asCarrier, directory, vehicles, drivers] = await Promise.all([
            listBookingsAsShipper(ctx.groupId),
            listBookingsAsCarrier(ctx.groupId),
            listOrgDirectory(),
            listVehicles(ctx.groupId),
            listDrivers(ctx.groupId),
          ])
          const all = [...asShipper, ...asCarrier]
          const loadIds = [...new Set(all.map((b) => b.load_id))]
          const loads = new Map<string, FreightLoad | null>()
          await Promise.all(
            loadIds.map(async (id) => {
              loads.set(id, await getLoadById(id).catch(() => null))
            }),
          )
          const bundles: BookingBundle[] = all.map((booking) => ({ booking, load: loads.get(booking.load_id) ?? null }))
          return { bundles, directory, vehicles, drivers }
        })(),
      ),
    [ctx.groupId],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải chuyến…</p>
  const { bundles, directory, vehicles, drivers } = data.data
  const nameOf = (groupId: string) => directory.find((o) => o.group_id === groupId)?.display_name ?? groupId.slice(0, 8)
  const mySide = (b: Booking): BookingSide => {
    if (b.shipper_group_id === ctx.groupId) return 'SHIPPER'
    // Thuộc nhóm nhà xe: nếu vai trò duy nhất của tôi là driver thì hành động với phía DRIVER.
    return ctx.roles.length === 1 && ctx.roles[0] === 'driver' ? 'DRIVER' : 'CARRIER'
  }
  const mine = bundles.filter((x) => x.booking.shipper_group_id === ctx.groupId)
  const carrying = bundles.filter((x) => x.booking.carrier_group_id === ctx.groupId)

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
            side={mySide(x.booking)}
            counterpartyName={nameOf(x.booking.carrier_group_id)}
            counterpartyLabel="Nhà xe"
            vehicles={[]}
            drivers={[]}
            onChanged={data.reload}
          />
        ))}
      </Card>
      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Chuyến tôi là nhà xe</h3>
        {carrying.length === 0 && <p className="text-slate-600">Chưa có chuyến nào.</p>}
        {carrying.map((x) => (
          <BookingCard
            key={x.booking.id}
            bundle={x}
            side={mySide(x.booking)}
            counterpartyName={nameOf(x.booking.shipper_group_id)}
            counterpartyLabel="Chủ hàng"
            vehicles={vehicles}
            drivers={drivers}
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
  vehicles,
  drivers,
  onChanged,
}: {
  bundle: BookingBundle
  side: BookingSide
  counterpartyName: string
  counterpartyLabel: string
  vehicles: Awaited<ReturnType<typeof listVehicles>>
  drivers: Awaited<ReturnType<typeof listDrivers>>
  onChanged: () => void
}) {
  const b = bundle.booking
  const load = bundle.load
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [vehicleId, setVehicleId] = useState(b.vehicle_id ?? '')
  const [driverId, setDriverId] = useState(b.driver_id ?? '')
  const events = useLoad(
    async () => (showEvents ? wrap(listBookingEvents(b.id)) : ([] as BookingEvent[])),
    [showEvents, b.id],
  )

  const actions = bookingActionsFor(b.status, side)
  const canAssignVD = side !== 'SHIPPER' && (b.status === 'BOOKED' || b.status === 'ARRIVED_PICKUP')

  async function act(to: BookingStatus) {
    setErr('')
    setBusy(true)
    try {
      if (b.status === 'PENDING_CONFIRM' && to === 'BOOKED') await respondBooking(b.id, true, strOrNull(note))
      else if (b.status === 'PENDING_CONFIRM' && to === 'DECLINED') await respondBooking(b.id, false, strOrNull(note))
      else if (to === 'CANCELLED') {
        if (!note.trim()) throw new Error('Huỷ chuyến bắt buộc ghi lý do.')
        await cancelBooking(b.id, note.trim())
      } else await advanceBooking(b.id, to, strOrNull(note))
      setNote('')
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveVD() {
    setErr('')
    setBusy(true)
    try {
      await assignVehicleDriver(b.id, vehicleId || null, driverId || null)
      onChanged()
    } catch (e) {
      setErr(freightErrText(e))
    } finally {
      setBusy(false)
    }
  }

  const vehicle = vehicles.find((v) => v.id === b.vehicle_id)
  const driver = drivers.find((d) => d.id === b.driver_id)

  return (
    <div className="space-y-2 border-b border-slate-100 pb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{b.code}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{BOOKING_STATUS_LABELS[b.status]}</span>
        {b.price_agreed != null && <span className="text-slate-600">Giá chốt {fmtMoney(b.price_agreed)}</span>}
        <span className="text-slate-600">
          {counterpartyLabel}: <span className="font-medium text-slate-800">{counterpartyName}</span>
        </span>
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
      {(vehicle || driver || b.vehicle_id || b.driver_id) && (
        <p className="text-slate-600">
          Xe: {vehicle?.plate ?? (b.vehicle_id ? '—' : 'chưa gán')} · Tài xế: {driver?.full_name ?? (b.driver_id ? '—' : 'chưa gán')}
        </p>
      )}
      {b.status === 'CANCELLED' && b.cancel_reason && <p className="text-slate-600">Lý do huỷ: {b.cancel_reason}</p>}
      {err && <Notice kind="error">{err}</Notice>}

      {canAssignVD && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-44 flex-1">
            <Field label="Xe chạy chuyến">
              <select className={inputClass} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">— Chưa gán —</option>
                {vehicles.filter((v) => v.active).map((v) => (
                  <option key={v.id} value={v.id}>{v.plate} · {v.vehicle_type}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="min-w-44 flex-1">
            <Field label="Tài xế">
              <select className={inputClass} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">— Chưa gán —</option>
                {drivers.filter((d) => d.active).map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Button kind="secondary" onClick={saveVD} disabled={busy}>Lưu xe / tài xế</Button>
        </div>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-52 flex-1">
            <Field label="Ghi chú / lý do (bắt buộc khi huỷ)">
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
        <p className="text-slate-500">Đang chờ nhà xe xác nhận. Muốn rút chỉ định: huỷ tải ở tab “Tìm xe / Tải đang đăng”.</p>
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
