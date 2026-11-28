import { useState } from 'react'
import { Button, Card, Field, Notice, inputClass, useLoad } from '../../shared/ui/ui'
import {
  freightAcctErrText,
  inviteAccountLink,
  listAccountDirectory,
  listMyAccountLinks,
  respondAccountLink,
  type AccountProfile,
} from '../../shared/supabase/freightAccount'
import { linkRelationWith } from '../../domain/freight/account'
import { SelfDeclaredNote, type FreightCtx } from './shared'

const wrap = <T,>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw new Error(freightAcctErrText(e))
  })

/**
 * Tab Kết nối: quan hệ giữa hai TÀI KHOẢN (thay kết nối giữa hai group
 * của T1). Kết nối cần hai bên đồng ý: một phía mời -> phía kia chấp
 * nhận. Tải mức NETWORK chỉ hiện với tài khoản đã kết nối (và tài khoản
 * cùng group trao đổi — xem view freight_loads_discover).
 */
export default function LinksTab({ ctx }: { ctx: FreightCtx }) {
  const [query, setQuery] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState('')
  const data = useLoad(
    () =>
      wrap(
        Promise.all([
          listMyAccountLinks(ctx.me),
          listAccountDirectory(),
        ]),
      ),
    [ctx.me],
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-slate-600">Đang tải kết nối…</p>
  const [links, directory] = data.data
  const nameOf = (id: string) => directory.find((p) => p.account_id === id)?.display_name ?? id.slice(0, 8)
  const profileOf = (id: string) => directory.find((p) => p.account_id === id)

  const accepted = links.filter((l) => l.status === 'ACCEPTED')
  const incoming = links.filter((l) => l.status === 'PENDING' && l.addressee_account_id === ctx.me)
  const outgoing = links.filter((l) => l.status === 'PENDING' && l.requester_account_id === ctx.me)
  const ended = links.filter((l) => l.status === 'ENDED')

  const q = query.trim()
  const results =
    q.length >= 2
      ? directory.filter(
          (p) =>
            p.account_id !== ctx.me &&
            (p.display_name.toLowerCase().includes(q.toLowerCase()) ||
              (p.contact_phone ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, ''))),
        )
      : []

  async function run(id: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusyId(id)
    setErr('')
    setMsg('')
    try {
      await fn()
      if (okMsg) setMsg(okMsg)
      data.reload()
    } catch (e) {
      setErr(freightAcctErrText(e))
    } finally {
      setBusyId('')
    }
  }

  const invite = (p: AccountProfile) =>
    run(p.account_id, () => inviteAccountLink(p.account_id), `Đã gửi lời mời kết nối tới ${p.display_name}.`)

  return (
    <div className="space-y-4">
      <SelfDeclaredNote />
      {err && <Notice kind="error">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}

      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Tìm tài khoản để kết nối</h3>
        <p className="text-slate-600">
          Tìm theo tên hiển thị hoặc số điện thoại trong danh bạ tài khoản đã đăng ký. Kết nối cần phía còn lại chấp
          nhận. Chỉ chỉ định được cho nhà xe đã có tài khoản và đã đăng ký vận tải trên hệ thống.
        </p>
        <Field label="Tìm tài khoản">
          <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Gõ ít nhất 2 ký tự…" />
        </Field>
        {q.length >= 2 && results.length === 0 && <p className="text-slate-600">Không tìm thấy tài khoản nào khớp.</p>}
        {results.map((p) => {
          const rel = linkRelationWith(links, ctx.me, p.account_id)
          return (
            <div key={p.account_id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
              <span className="font-medium">{p.display_name}</span>
              <span className="text-slate-600">
                {[p.is_shipper ? 'Chủ kho' : null, p.is_carrier ? 'Vận tải' : null].filter(Boolean).join(' + ')}
                {p.province ? ` · ${p.province}` : ''}
                {p.contact_phone ? ` · ${p.contact_phone}` : ''}
              </span>
              <span className="ml-auto">
                {rel === 'ACCEPTED' && <span className="font-medium text-emerald-700">Đã kết nối</span>}
                {rel === 'PENDING_OUT' && <span className="text-slate-500">Đang chờ phía kia xác nhận…</span>}
                {rel === 'PENDING_IN' && <span className="text-slate-500">Đã mời bạn — xem mục “Lời mời chờ xác nhận” bên dưới</span>}
                {(rel === null || rel === 'ENDED') && (
                  <Button kind="secondary" disabled={busyId === p.account_id} onClick={() => invite(p)}>
                    {rel === 'ENDED' ? 'Mời lại' : 'Mời kết nối'}
                  </Button>
                )}
              </span>
            </div>
          )
        })}
      </Card>

      {incoming.length > 0 && (
        <Card className="space-y-3">
          <h3 className="text-lg font-semibold">Lời mời chờ xác nhận</h3>
          {incoming.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
              <span className="font-medium">{nameOf(l.requester_account_id)}</span>
              <span className="text-slate-600">{profileOf(l.requester_account_id)?.contact_phone ?? ''}</span>
              <span className="ml-auto flex gap-2">
                <Button disabled={busyId === l.id} onClick={() => run(l.id, () => respondAccountLink(l.id, true))}>Chấp nhận</Button>
                <Button kind="secondary" disabled={busyId === l.id} onClick={() => run(l.id, () => respondAccountLink(l.id, false))}>Từ chối</Button>
              </span>
            </div>
          ))}
        </Card>
      )}

      <Card className="space-y-3">
        <h3 className="text-lg font-semibold">Đã kết nối ({accepted.length})</h3>
        {accepted.length === 0 && <p className="text-slate-600">Chưa kết nối với tài khoản nào.</p>}
        {accepted.map((l) => {
          const other = l.requester_account_id === ctx.me ? l.addressee_account_id : l.requester_account_id
          return (
            <div key={l.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
              <span className="font-medium">{nameOf(other)}</span>
              <span className="text-slate-600">
                {profileOf(other)?.contact_phone ?? ''}
                {l.source === 'PAST_DEAL' ? ' · Đã từng chạy chuyến cùng nhau' : ''}
              </span>
              <span className="ml-auto">
                <Button
                  kind="secondary"
                  disabled={busyId === l.id}
                  onClick={() => run(l.id, () => respondAccountLink(l.id, false))}
                >
                  Kết thúc kết nối
                </Button>
              </span>
            </div>
          )
        })}
        {outgoing.length > 0 && (
          <>
            <h4 className="font-medium">Lời mời tôi đã gửi, đang chờ ({outgoing.length})</h4>
            {outgoing.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-2">
                <span className="font-medium">{nameOf(l.addressee_account_id)}</span>
                <span className="ml-auto">
                  <Button kind="secondary" disabled={busyId === l.id} onClick={() => run(l.id, () => respondAccountLink(l.id, false))}>
                    Rút lời mời
                  </Button>
                </span>
              </div>
            ))}
          </>
        )}
        {ended.length > 0 && <p className="text-slate-500">{ended.length} kết nối đã kết thúc — có thể mời lại ở ô tìm kiếm phía trên.</p>}
      </Card>
    </div>
  )
}
