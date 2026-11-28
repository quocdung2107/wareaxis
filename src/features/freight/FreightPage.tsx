import { useState } from 'react'
import { Button, Card, Notice, useLoad } from '../../shared/ui/ui'
import { freightStatus } from '../../shared/supabase/freight'
import { freightAcctErrText, getMyAccountProfile } from '../../shared/supabase/freightAccount'
import { LoginForm } from '../orders/LoginForm'
import { useSession } from '../orders/useSession'
import { ProfileDialog } from './ProfileDialog'
import type { FreightCtx } from './shared'
import AccountTab from './AccountTab'
import LoadsTab from './LoadsTab'
import BookingsTab from './BookingsTab'
import LinksTab from './LinksTab'

type Tab = 'account' | 'loads' | 'bookings' | 'links'
const TABS: { id: Tab; label: string }[] = [
  { id: 'account', label: 'Đăng ký của tôi' },
  { id: 'loads', label: 'Tìm xe / Tải' },
  { id: 'bookings', label: 'Chuyến của tôi' },
  { id: 'links', label: 'Kết nối' },
]

export default function FreightPage() {
  if (freightStatus() === 'unconfigured') {
    return (
      <div className="space-y-3">
        <Notice kind="warn">
          Chưa cấu hình Supabase (thiếu VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) nên phần Tìm xe &amp; chuyến chưa
          hoạt động. Phần kho vẫn chạy bình thường.
        </Notice>
        <Notice>
          Để bật lớp trung gian giao tiếp: (1) cấu hình hai biến môi trường Supabase như tab Đơn &amp; chat; (2) trong
          Supabase Dashboard → SQL Editor, chạy <code>supabase/reset_freight.sql</code> rồi áp migration gộp bản sạch{' '}
          <code>supabase/migrations/20261128020000_freight_account_model_fresh.sql</code> (xem tài liệu hướng dẫn reset
          &amp; cài lại freight đi kèm dự án); (3) đăng nhập và đăng ký hồ sơ của tài khoản bạn tại đây.
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
  return <AccountGate me={session.user.id} displayName={session.user.email ?? ''} />
}

/**
 * Cổng vào theo TÀI KHOẢN (R1): không cần chọn group nữa. Chưa có hồ sơ
 * đăng ký thì hiện màn hình chào + nút mở dialog đăng ký; đã có thì vào
 * thẳng các tab. Hồ sơ nạp một lần ở đây và truyền xuống qua FreightCtx.
 */
function AccountGate({ me, displayName }: { me: string; displayName: string }) {
  const [tab, setTab] = useState<Tab>('account')
  const [registerOpen, setRegisterOpen] = useState(false)
  const profile = useLoad(
    () =>
      getMyAccountProfile(me).catch((e) => {
        throw new Error(freightAcctErrText(e))
      }),
    [me],
  )

  if (profile.error) {
    return (
      <div className="space-y-3">
        <Notice kind="error">Không tải được hồ sơ tài khoản: {profile.error}</Notice>
        <Notice>
          Nếu lỗi nhắc tới bảng <code>freight_account_profiles</code> chưa tồn tại, migration gộp bản sạch (
          <code>20261128020000_freight_account_model_fresh.sql</code>) chưa được áp trên Supabase — chạy{' '}
          <code>supabase/reset_freight.sql</code> rồi áp migration đó theo tài liệu hướng dẫn reset &amp; cài lại
          freight đi kèm dự án.
        </Notice>
      </div>
    )
  }
  if (profile.loading && !profile.data) return <p className="text-slate-600">Đang tải hồ sơ của bạn…</p>

  if (!profile.data) {
    return (
      <div className="space-y-4">
        <Card className="space-y-3">
          <h3 className="text-lg font-semibold">Đăng ký của tôi</h3>
          <p className="text-slate-600">
            Tài khoản của bạn chưa có thông tin đăng ký cho lớp trung gian giao tiếp. Mỗi tài khoản có một thông tin
            đăng ký riêng của mình: xác định bạn là <strong>chủ kho</strong> (và tạo nội dung chủ kho: các kho của
            bạn), đăng ký <strong>vận tải</strong> (đội xe của bạn), hoặc cả hai — không thông qua group. Group chỉ
            là nơi trao đổi giữa chủ hàng và vận tải.
          </p>
          <p className="text-slate-600">
            Thông tin đăng ký là thông tin do bạn tự khai — các bên tự xác minh khi giao dịch; hệ thống không duyệt
            hồ sơ.
          </p>
          <Button onClick={() => setRegisterOpen(true)}>Đăng ký hồ sơ của tôi</Button>
        </Card>
        {registerOpen && (
          <ProfileDialog
            initial={null}
            defaultDisplayName={displayName}
            onClose={() => setRegisterOpen(false)}
            onSaved={() => {
              setRegisterOpen(false)
              profile.reload()
            }}
          />
        )}
      </div>
    )
  }

  const ctx: FreightCtx = { me, account: profile.data }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Mục tìm xe và chuyến">
        {TABS.map((t) => (
          <Button key={t.id} kind={tab === t.id ? 'primary' : 'secondary'} onClick={() => setTab(t.id)} aria-pressed={tab === t.id}>
            {t.label}
          </Button>
        ))}
      </div>
      {tab === 'account' && (
        <AccountTab key={`a-${profile.data.updated_at}`} ctx={ctx} onAccountChanged={profile.reload} />
      )}
      {tab === 'loads' && <LoadsTab key="l" ctx={ctx} onGoBookings={() => setTab('bookings')} />}
      {tab === 'bookings' && <BookingsTab key="b" ctx={ctx} />}
      {tab === 'links' && <LinksTab key="k" ctx={ctx} />}
    </div>
  )
}
