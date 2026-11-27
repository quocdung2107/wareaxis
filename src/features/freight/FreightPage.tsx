import { useState } from 'react'
import { Button, Notice, useLoad } from '../../shared/ui/ui'
import { freightErrText, freightStatus, listMyGroups, myRolesInGroup } from '../../shared/supabase/freight'
import { LoginForm } from '../orders/LoginForm'
import { useSession } from '../orders/useSession'
import type { FreightCtx } from './shared'
import ProfileTab from './ProfileTab'
import LoadsTab from './LoadsTab'
import BookingsTab from './BookingsTab'

const KEY = 'wa.group'
const saved = () => {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

type Tab = 'profile' | 'loads' | 'bookings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Hồ sơ đơn vị' },
  { id: 'loads', label: 'Tìm xe / Tải đang đăng' },
  { id: 'bookings', label: 'Chuyến của tôi' },
]

export default function FreightPage() {
  if (freightStatus() === 'unconfigured') {
    return (
      <div className="space-y-3">
        <Notice kind="warn">
          Chưa cấu hình Supabase (thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) nên phần Vận tải chưa hoạt động. Phần
          kho vẫn chạy bình thường.
        </Notice>
        <Notice>
          Để bật lớp trung gian giao tiếp: (1) cấu hình hai biến môi trường Supabase như tab Đơn &amp; chat; (2) áp
          migration <code>supabase/migrations/20261127000000_freight_t1_foundation.sql</code> trong Supabase Dashboard →
          SQL Editor (xem tài liệu hướng dẫn T0/T1 đi kèm dự án); (3) đăng nhập và khai hồ sơ đơn vị tại đây.
        </Notice>
      </div>
    )
  }
  return <FreightInner />
}

function FreightInner() {
  const session = useSession()
  if (session === undefined) return <p className="text-slate-600">Đang kiểm tra đăng nhập…</p>
  if (!session) return <LoginForm />
  return <Groups me={session.user.id} />
}

function Groups({ me }: { me: string }) {
  const [sel, setSel] = useState(saved)
  const [tab, setTab] = useState<Tab>('profile')
  const groups = useLoad(
    () =>
      listMyGroups().catch((e) => {
        throw new Error(freightErrText(e))
      }),
    [],
  )
  const current = groups.data?.find((g) => g.id === sel) ?? groups.data?.[0]
  const roles = useLoad(
    async () => (current ? myRolesInGroup(current.id, me).catch(() => [] as string[]) : ([] as string[])),
    [current?.id, me],
  )

  function pick(id: string) {
    setSel(id)
    try {
      localStorage.setItem(KEY, id)
    } catch {
      /* bỏ qua */
    }
  }

  if (groups.error) return <Notice kind="error">Không tải được danh sách group: {groups.error}</Notice>
  if (!groups.data) return <p className="text-slate-600">Đang tải…</p>
  if (groups.data.length === 0) {
    return <Notice>Bạn chưa thuộc group nào. Hãy tạo group hoặc nhờ admin thêm bạn ở tab Đơn &amp; chat trước.</Notice>
  }

  const ctx: FreightCtx = { groupId: current!.id, groupName: current!.name, me, roles: roles.data ?? [] }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Group">
        {groups.data.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={current?.id === g.id}
            onClick={() => pick(g.id)}
            className={`min-h-11 max-w-full truncate rounded-lg border px-4 text-base ${
              current?.id === g.id ? 'border-brand-600 bg-brand-600 font-semibold text-white' : 'border-slate-300 bg-white'
            }`}
          >
            {g.name}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Mục vận tải">
        {TABS.map((t) => (
          <Button key={t.id} kind={tab === t.id ? 'primary' : 'secondary'} onClick={() => setTab(t.id)} aria-pressed={tab === t.id}>
            {t.label}
          </Button>
        ))}
      </div>

      {tab === 'profile' && <ProfileTab key={`p-${ctx.groupId}`} ctx={ctx} />}
      {tab === 'loads' && <LoadsTab key={`l-${ctx.groupId}`} ctx={ctx} />}
      {tab === 'bookings' && <BookingsTab key={`b-${ctx.groupId}`} ctx={ctx} />}
    </div>
  )
}
