import { useState } from 'react'
import {
  createFederationKey, listFederationKeys, listFederationQueryLogs, portalUrl,
  revokeFederationKey, updateFederationKeyPolicy,
  type FederationKey,
} from '../../shared/inventory/federation.ts'
import type { SharePolicy } from '../../domain/federation/policy.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const POLICY_FIELDS: { key: keyof SharePolicy; label: string; hint: string }[] = [
  { key: 'share_available', label: 'Tồn khả dụng', hint: 'Cho khoá này tra available theo SKU/lô' },
  { key: 'share_low_stock', label: 'Tồn thấp', hint: 'Cho khoá này xem SKU dưới mức tối thiểu' },
  { key: 'share_cost_price', label: 'Giá vốn', hint: 'Kèm giá nhập lô trong kết quả — mặc định TẮT, chỉ bật khi thật cần' },
]

function PolicySwitches({
  value, onChange, disabled,
}: { value: SharePolicy; onChange: (p: SharePolicy) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      {POLICY_FIELDS.map((f) => (
        <label key={f.key} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={value[f.key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.checked })}
          />
          <span>
            <span className="block font-medium">{f.label}</span>
            <span className="block text-sm text-slate-600">{f.hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

export default function FederationPage() {
  const keys = useLoad(() => listFederationKeys(), [])
  const logs = useLoad(() => listFederationQueryLogs(), [])
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<SharePolicy>({
    share_available: true, share_low_stock: false, share_cost_price: false,
  })
  const [newPlaintext, setNewPlaintext] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [serverAddress, setServerAddress] = useState('')
  const portal = portalUrl(serverAddress)

  async function create() {
    setBusy(true); setError(''); setCopied(false)
    try {
      const { plaintext } = await createFederationKey(name, policy)
      setNewPlaintext(plaintext)
      setName('')
      keys.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function copyPlaintext() {
    try {
      await navigator.clipboard.writeText(newPlaintext)
      setCopied(true)
    } catch {
      setError('Không sao chép tự động được — hãy bôi đen khoá và sao chép thủ công.')
    }
  }

  async function togglePolicy(k: FederationKey, next: SharePolicy) {
    setError('')
    try {
      await updateFederationKeyPolicy(k.id, next)
      keys.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function revoke(k: FederationKey) {
    if (!window.confirm(`Thu hồi khoá "${k.name}"? Phía đang giữ khoá này sẽ bị từ chối ngay.`)) return
    setError('')
    try {
      await revokeFederationKey(k.id)
      keys.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4">
      <Notice>
        Liên kho chỉ <strong>đọc ở mức truy vấn</strong>: kho khác thấy tồn khả dụng của kho này
        qua API chỉ-đọc, không có cơ sở dữ liệu tồn trung tâm và không ai sửa được tồn của kho
        này. Giá vốn <strong>không</strong> chia sẻ trừ khi bật riêng cho từng khoá. Mọi truy vấn
        đều được ghi nhật ký. Các kho nối nhau qua VPN riêng (Tailscale/WireGuard) — không mở
        server kho ra Internet.
      </Notice>

      {error && <Notice kind="error">{error}</Notice>}

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Tạo khoá liên kho mới</h2>
        <p className="text-sm text-slate-600">
          Khoá cấp cho một phía cụ thể (một portal hoặc một kho đối tác). Khoá plaintext chỉ
          hiển thị <strong>đúng 1 lần</strong> ngay sau khi tạo — hệ thống chỉ lưu bản băm
          SHA-256, mất khoá thì thu hồi và tạo khoá mới.
        </p>
        <Field label="Tên khoá (phía được cấp)">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ví dụ: Portal văn phòng, Kho đại lý B"
          />
        </Field>
        <PolicySwitches value={policy} onChange={setPolicy} />
        <Button kind="primary" onClick={create} disabled={busy || !name.trim()}>
          Tạo khoá
        </Button>
        {newPlaintext && (
          <div className="space-y-2 rounded-lg bg-amber-50 px-3 py-2">
            <p className="font-medium text-amber-900">
              Khoá mới — sao chép ngay, sẽ không hiển thị lại:
            </p>
            <code className="block break-all rounded bg-white px-3 py-2 text-base">{newPlaintext}</code>
            <Button onClick={copyPlaintext}>{copied ? 'Đã sao chép ✓' : 'Sao chép khoá'}</Button>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Khoá đã cấp</h2>
        {keys.loading && <p className="text-slate-600">Đang tải…</p>}
        {keys.error && <Notice kind="error">{keys.error}</Notice>}
        {keys.data && keys.data.length === 0 && (
          <p className="text-slate-600">Chưa cấp khoá nào. Khoá hệ thống qua biến môi trường WMS_FEDERATION_KEY (nếu đặt trên server) vẫn hoạt động độc lập với danh sách này.</p>
        )}
        <div className="space-y-3">
          {keys.data?.map((k) => (
            <div key={k.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{k.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${k.active ? 'bg-brand-50 text-brand-800' : 'bg-red-50 text-red-700'}`}>
                  {k.active ? 'Đang hoạt động' : 'Đã thu hồi'}
                </span>
                <span className="text-sm text-slate-500">
                  Tạo {k.created_at || '—'}{k.last_used_at ? ` · Dùng gần nhất ${k.last_used_at}` : ' · Chưa được dùng'}
                </span>
                {k.active && (
                  <Button kind="danger" className="ml-auto" onClick={() => revoke(k)}>
                    Thu hồi
                  </Button>
                )}
              </div>
              <PolicySwitches
                value={k.policy}
                disabled={!k.active}
                onChange={(next) => togglePolicy(k, next)}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Cổng liên kho (Portal)</h2>
        <p className="text-sm text-slate-600">
          Cổng tổng hợp chạy ngay trên Warehouse Server của một máy được chỉ định: tra một SKU
          thấy tồn của mọi kho cùng lúc; kho nào offline, cổng hiển thị số liệu gần nhất kèm
          nhãn thời điểm (không giả vờ là số trực tiếp). Nhập địa chỉ máy chủ chạy portal
          (ví dụ <code>192.168.1.10</code> trong LAN, hoặc địa chỉ Tailscale của máy văn phòng)
          rồi mở cổng trong tab mới. Cấu hình danh sách kho peer do người có quyền
          federation_manage thực hiện qua API của server đó.
        </p>
        <Field label="Địa chỉ máy chủ chạy cổng liên kho">
          <input
            className={inputClass}
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
            placeholder="Ví dụ: 192.168.1.10 hoặc http://100.64.0.5:8787"
          />
        </Field>
        {portal ? (
          <a
            href={portal}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-base font-medium text-white hover:bg-brand-700"
          >
            Mở cổng liên kho ({portal})
          </a>
        ) : (
          <p className="text-sm text-slate-500">Nhập địa chỉ hợp lệ để hiện nút mở cổng.</p>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">Nhật ký truy vấn liên kho</h2>
        {logs.loading && <p className="text-slate-600">Đang tải…</p>}
        {logs.error && <Notice kind="error">{logs.error}</Notice>}
        {logs.data && logs.data.length === 0 && (
          <Notice kind="warn">
            Chưa có truy vấn nào được ghi. Ở chế độ standalone (không chạy Warehouse Server),
            kho này không nhận truy vấn từ bên ngoài nên nhật ký trống là bình thường — nhật ký
            đầy đủ nằm trên Warehouse Server của kho (API /api/federation/query-log).
          </Notice>
        )}
        {logs.data && logs.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-600">
                  <th className="py-2 pr-3">Thời gian</th>
                  <th className="py-2 pr-3">Phía hỏi</th>
                  <th className="py-2 pr-3">Loại</th>
                  <th className="py-2 pr-3">SKU</th>
                  <th className="py-2">Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3">{l.created_at || '—'}</td>
                    <td className="py-2 pr-3">{l.requested_by || l.peer_warehouse_code || '—'}</td>
                    <td className="py-2 pr-3">{l.query_type}</td>
                    <td className="py-2 pr-3">{l.sku || '—'}</td>
                    <td className="py-2">{l.result_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
