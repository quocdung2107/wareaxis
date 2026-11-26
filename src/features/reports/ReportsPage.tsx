import { useMemo, useState } from 'react'
import {
  getInOut, getJournal, getReconciliation, getReportOverview, getStockCard, getValuation,
  listMovementActors, listMovementSkus, listReportLots,
} from '../../shared/inventory/reports.ts'
import { listLocations, listWarehouses } from '../../shared/inventory/purchase.ts'
import { exportRows } from '../../shared/inventory/exportFile.ts'
import { MOVEMENT_TYPES } from '../../domain/ledger/types.ts'
import { summarizeByType } from '../../domain/reports/journal.ts'
import { Button, Card, Field, inputClass, Notice, useLoad } from '../../shared/ui/ui.tsx'

const fmt = (n: number | null | undefined) => (n == null ? '—' : String(n))
const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('vi-VN', { maximumFractionDigits: 2 })
const today = () => new Date().toISOString().slice(0, 10)
const monthStart = () => `${today().slice(0, 8)}01`

type Tab = 'card' | 'inout' | 'valuation' | 'recon' | 'journal' | 'webhook'
const TABS: { id: Tab; label: string }[] = [
  { id: 'card', label: 'Thẻ kho' },
  { id: 'inout', label: 'Nhập–Xuất–Tồn' },
  { id: 'valuation', label: 'Định giá tồn' },
  { id: 'recon', label: 'Đối chiếu MISA' },
  { id: 'journal', label: 'Nhật ký' },
  { id: 'webhook', label: 'Webhook' },
]

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('card')
  const overview = useLoad(() => getReportOverview(), [])
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><div className="text-sm text-slate-500">SKU đang có tồn (sổ cái)</div>
          <div className="text-2xl font-bold">{fmt(overview.data?.sku_with_stock)}</div></Card>
        <Card><div className="text-sm text-slate-500">Tổng tồn khả dụng</div>
          <div className="text-2xl font-bold">{fmt(overview.data?.total_available)}</div></Card>
        <Card><div className="text-sm text-slate-500">Giá trị tồn (phần có giá nhập)</div>
          <div className="text-2xl font-bold">{fmtMoney(overview.data?.total_value)}</div>
          {overview.data && overview.data.unpriced_lots > 0 && (
            <div className="text-sm text-amber-700">{overview.data.unpriced_lots} lô chưa có giá — chưa tính vào tổng</div>)}
        </Card>
        <Card><div className="text-sm text-slate-500">Cảnh báo đang mở</div>
          <div className="text-2xl font-bold">{fmt(overview.data?.open_alerts)}</div></Card>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Báo cáo">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`min-h-11 rounded-lg px-4 font-medium ${tab === t.id ? 'bg-brand-600 text-white' : 'border border-slate-300 bg-white'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <Notice>
        Báo cáo chỉ đọc số liệu từ sổ cái (stock_movements / stock_balances) — không sửa tồn.
        Hàng theo lô (nhận qua PO) và hàng nạp file là hai thế giới tồn song song; tab Đối chiếu
        cho thấy chênh lệch giữa chúng để đối soát với MISA.
      </Notice>
      {tab === 'card' && <StockCardTab />}
      {tab === 'inout' && <InOutTab />}
      {tab === 'valuation' && <ValuationTab />}
      {tab === 'recon' && <ReconTab />}
      {tab === 'journal' && <JournalTab />}
      {tab === 'webhook' && <WebhookTab />}
    </div>
  )
}

// ================= Thẻ kho =================
function StockCardTab() {
  const skus = useLoad(() => listMovementSkus(), [])
  const [sku, setSku] = useState('')
  const lots = useLoad(() => listReportLots(sku || undefined), [sku])
  const [lotId, setLotId] = useState('')
  const result = useLoad(
    () => (lotId ? getStockCard(Number(lotId)) : Promise.resolve(null)),
    [lotId],
  )
  const locations = useLoad(() => listLocations(), [])
  const locCode = useMemo(() => {
    const m = new Map((locations.data ?? []).map((l) => [l.id, l.code]))
    return (id: number | null) => (id == null ? '—' : m.get(id) ?? `#${id}`)
  }, [locations.data])

  async function exportCsv() {
    if (!result.data) return
    const aoa: (string | number | null)[][] = [
      ['Thời gian', 'Loại', 'Chứng từ', 'Vị trí', 'Từ vị trí', 'Số lượng', 'Tồn sau dòng', 'Khả dụng sau dòng', 'Lý do', 'Người thực hiện'],
      ...result.data.card.lines.map((l) => [
        l.at ?? '', l.type, l.doc_type ? `${l.doc_type} #${l.doc_id ?? ''}` : '',
        locCode(l.location_id), locCode(l.from_location_id), l.qty,
        l.balance_after.on_hand, l.available_after, l.reason_code ?? '', l.actor ?? '',
      ]),
    ]
    await exportRows(aoa, `the-kho-lo-${lotId}`, 'csv')
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SKU">
            <select className={inputClass} value={sku} onChange={(e) => { setSku(e.target.value); setLotId('') }}>
              <option value="">— Tất cả SKU —</option>
              {(skus.data ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Lô">
            <select className={inputClass} value={lotId} onChange={(e) => setLotId(e.target.value)}>
              <option value="">— Chọn lô —</option>
              {(lots.data ?? []).map((l) => (
                <option key={l.lot_id} value={l.lot_id}>
                  Lô #{l.lot_id} · {l.sku}{l.batch_no ? ` · batch ${l.batch_no}` : ''}{l.expiry_date ? ` · HSD ${l.expiry_date}` : ''} · tồn {l.on_hand}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
      {result.data && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span>Số dư cuối thẻ: <b>{result.data.card.closing.on_hand}</b></span>
            <span>Tổng balances của lô: <b>{result.data.balances_on_hand}</b></span>
            {Math.abs(result.data.card.closing.on_hand - result.data.balances_on_hand) < 1e-9
              ? <span className="text-brand-700 font-medium">Khớp ✓</span>
              : <span className="text-red-700 font-medium">Lệch — cần kiểm tra sổ cái</span>}
            <Button onClick={exportCsv}>Xuất CSV</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-2">Thời gian</th><th className="pr-2">Loại</th><th className="pr-2">Chứng từ</th>
                <th className="pr-2">Vị trí</th><th className="pr-2 text-right">SL</th>
                <th className="pr-2 text-right">Δ on_hand</th><th className="pr-2 text-right">Tồn sau dòng</th>
                <th className="pr-2 text-right">Khả dụng</th><th>Người</th>
              </tr></thead>
              <tbody>
                {result.data.card.lines.map((l) => (
                  <tr key={l.movement_id ?? `${l.at}-${l.type}`} className="border-t border-slate-100">
                    <td className="py-1 pr-2 whitespace-nowrap">{l.at}</td>
                    <td className="pr-2">{l.type}</td>
                    <td className="pr-2">{l.doc_type ? `${l.doc_type} #${l.doc_id ?? ''}` : '—'}</td>
                    <td className="pr-2">{locCode(l.location_id)}{l.from_location_id ? ` ← ${locCode(l.from_location_id)}` : ''}</td>
                    <td className="pr-2 text-right">{l.qty}</td>
                    <td className="pr-2 text-right">{l.delta.on_hand > 0 ? `+${l.delta.on_hand}` : l.delta.on_hand}</td>
                    <td className="pr-2 text-right font-medium">{l.balance_after.on_hand}</td>
                    <td className="pr-2 text-right">{l.available_after}</td>
                    <td>{l.actor ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ================= Nhập–Xuất–Tồn =================
function InOutTab() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [wh, setWh] = useState('')
  const warehouses = useLoad(() => listWarehouses(), [])
  const result = useLoad(
    () => getInOut(from, to, wh ? Number(wh) : null),
    [from, to, wh],
  )
  async function exportXlsx() {
    if (!result.data) return
    await exportRows([
      ['SKU', 'Tồn đầu kỳ', 'Nhập trong kỳ', 'Xuất trong kỳ', 'Tồn cuối kỳ'],
      ...result.data.rows.map((r) => [r.sku, r.opening, r.in_qty, r.out_qty, r.closing]),
    ], 'nhap-xuat-ton', 'xlsx')
  }
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Từ ngày"><input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Đến ngày"><input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Kho">
            <select className={inputClass} value={wh} onChange={(e) => setWh(e.target.value)}>
              <option value="">— Mọi kho —</option>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Nhập = RECEIVE / RETURN_IN / ADJUST_IN / TRANSFER_IN; Xuất = PICK / ADJUST_OUT / WRITE_OFF / TRANSFER_OUT
          (tính trên on_hand; các movement chỉ đổi xô/vị trí như ALLOCATE, FREEZE, DAMAGE, MOVE không tính).
        </p>
      </Card>
      {result.data && (
        <Card>
          <div className="mb-2"><Button onClick={exportXlsx}>Xuất Excel</Button></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-2">SKU</th><th className="pr-2 text-right">Đầu kỳ</th>
                <th className="pr-2 text-right">Nhập</th><th className="pr-2 text-right">Xuất</th>
                <th className="pr-2 text-right">Cuối kỳ</th><th className="text-right">Theo balances hiện tại</th>
              </tr></thead>
              <tbody>
                {result.data.rows.map((r) => (
                  <tr key={r.sku} className="border-t border-slate-100">
                    <td className="py-1 pr-2 font-medium">{r.sku}</td>
                    <td className="pr-2 text-right">{r.opening}</td>
                    <td className="pr-2 text-right">{r.in_qty}</td>
                    <td className="pr-2 text-right">{r.out_qty}</td>
                    <td className="pr-2 text-right font-medium">{r.closing}</td>
                    <td className="text-right">{fmt(result.data!.balances_on_hand[r.sku])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ================= Định giá =================
function ValuationTab() {
  const result = useLoad(() => getValuation(), [])
  async function exportXlsx() {
    if (!result.data) return
    await exportRows([
      ['Lô', 'SKU', 'Batch', 'HSD', 'Giá nhập', 'Tồn vật lý', 'Trong đó hỏng', 'SL định giá', 'Giá trị', 'Có giá'],
      ...result.data.rows.map((r) => [
        r.lot_id, r.sku, r.batch_no ?? '', r.expiry_date ?? '', r.purchase_price ?? '',
        r.qty_physical, r.qty_damaged, r.qty_valued, r.value ?? '', r.priced ? 'Có' : 'Chưa có giá',
      ]),
    ], 'dinh-gia-ton', 'xlsx')
  }
  const d = result.data
  return (
    <div className="space-y-3">
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card><div className="text-sm text-slate-500">Tổng giá trị tồn (có giá)</div>
              <div className="text-2xl font-bold">{fmtMoney(d.total_value)}</div></Card>
            <Card><div className="text-sm text-slate-500">Tổng SL định giá</div>
              <div className="text-2xl font-bold">{d.total_qty_valued}</div></Card>
            <Card><div className="text-sm text-slate-500">Hàng hỏng (tách riêng)</div>
              <div className="text-2xl font-bold">{d.total_qty_damaged}</div>
              <div className="text-sm text-slate-500">giá trị {fmtMoney(d.total_damaged_value)}</div></Card>
            <Card><div className="text-sm text-slate-500">Lô chưa có giá nhập</div>
              <div className="text-2xl font-bold">{d.unpriced.lot_count}</div>
              <div className="text-sm text-slate-500">SL {d.unpriced.qty_valued} — không tính vào tổng giá trị</div></Card>
          </div>
          <Card>
            <div className="mb-2"><Button onClick={exportXlsx}>Xuất Excel</Button></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-slate-500">
                  <th className="py-1 pr-2">Lô</th><th className="pr-2">SKU</th><th className="pr-2 text-right">Giá nhập</th>
                  <th className="pr-2 text-right">Tồn vật lý</th><th className="pr-2 text-right">Hỏng</th>
                  <th className="pr-2 text-right">SL định giá</th><th className="text-right">Giá trị</th>
                </tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.lot_id} className="border-t border-slate-100">
                      <td className="py-1 pr-2">#{r.lot_id}</td>
                      <td className="pr-2 font-medium">{r.sku}</td>
                      <td className="pr-2 text-right">{r.priced ? fmtMoney(r.purchase_price) : <span className="text-amber-700">chưa có giá</span>}</td>
                      <td className="pr-2 text-right">{r.qty_physical}</td>
                      <td className="pr-2 text-right">{r.qty_damaged}</td>
                      <td className="pr-2 text-right">{r.qty_valued}</td>
                      <td className="text-right font-medium">{fmtMoney(r.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

// ================= Đối chiếu =================
const RECON_LABEL: Record<string, string> = {
  MATCH: 'Khớp', DIFF: 'Lệch', ONLY_LEDGER: 'Chỉ có ở sổ cái', ONLY_FILE: 'Chỉ có ở file',
}
function ReconTab() {
  const result = useLoad(() => getReconciliation(), [])
  async function exportXlsx() {
    if (!result.data) return
    await exportRows([
      ['SKU', 'Tồn sổ cái (ledger)', 'Tồn file (MISA)', 'Chênh lệch', 'Trạng thái'],
      ...result.data.map((r) => [r.sku, r.ledger_qty, r.file_qty, r.diff, RECON_LABEL[r.status]]),
    ], 'doi-chieu-misa', 'xlsx')
  }
  return (
    <div className="space-y-3">
      <Notice kind="info">
        Tồn file = Σ qty_system của kỳ hiện hành − số đã lấy kể từ lần nạp file (đúng công thức app
        hiển thị; sửa tay đã nằm trong qty_system). Hàng nhận qua PO chỉ có ở sổ cái, hàng nạp file
        chưa vào lô chỉ có ở file — đó là hai nguồn song song, dùng bảng này để đối soát với MISA.
      </Notice>
      {result.data && (
        <Card>
          <div className="mb-2"><Button onClick={exportXlsx}>Xuất file đối chiếu</Button></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-2">SKU</th><th className="pr-2 text-right">Sổ cái</th>
                <th className="pr-2 text-right">File</th><th className="pr-2 text-right">Lệch</th><th>Trạng thái</th>
              </tr></thead>
              <tbody>
                {result.data.map((r) => (
                  <tr key={r.sku} className="border-t border-slate-100">
                    <td className="py-1 pr-2 font-medium">{r.sku}</td>
                    <td className="pr-2 text-right">{r.ledger_qty}</td>
                    <td className="pr-2 text-right">{r.file_qty}</td>
                    <td className="pr-2 text-right">{r.diff}</td>
                    <td>{RECON_LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ================= Nhật ký =================
function JournalTab() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [type, setType] = useState('')
  const [actor, setActor] = useState('')
  const [sku, setSku] = useState('')
  const actors = useLoad(() => listMovementActors(), [])
  const result = useLoad(
    () => getJournal({
      from, to,
      type: (type || null) as never,
      actor: actor || null,
      sku: sku || null,
    }),
    [from, to, type, actor, sku],
  )
  const summary = useMemo(() => summarizeByType(result.data ?? []), [result.data])
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Từ ngày"><input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Đến ngày"><input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Loại biến động">
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">— Tất cả —</option>
              {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Người thực hiện">
            <select className={inputClass} value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">— Tất cả —</option>
              {(actors.data ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="SKU"><input className={inputClass} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Lọc theo SKU" /></Field>
        </div>
        {summary.length > 0 && (
          <p className="mt-2 text-sm text-slate-500">
            {summary.map((s) => `${s.type}: ${s.count} dòng / ${s.qty}`).join(' · ')}
          </p>
        )}
      </Card>
      {result.data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500">
                <th className="py-1 pr-2">Thời gian</th><th className="pr-2">Loại</th><th className="pr-2">SKU</th>
                <th className="pr-2">Lô</th><th className="pr-2 text-right">SL</th><th className="pr-2">Chứng từ</th>
                <th className="pr-2">Lý do</th><th>Người</th>
              </tr></thead>
              <tbody>
                {result.data.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="py-1 pr-2 whitespace-nowrap">{m.created_at}</td>
                    <td className="pr-2">{m.type}</td>
                    <td className="pr-2 font-medium">{m.sku}</td>
                    <td className="pr-2">{m.lot_id ?? '—'}</td>
                    <td className="pr-2 text-right">{m.qty}</td>
                    <td className="pr-2">{m.doc_type ? `${m.doc_type} #${m.doc_id ?? ''}` : '—'}</td>
                    <td className="pr-2">{m.reason_code ?? ''}</td>
                    <td>{m.actor ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ================= Webhook =================
function WebhookTab() {
  return (
    <div className="space-y-3">
      <Notice kind="warn">
        Webhook chỉ chạy khi kho dùng Warehouse Server (máy chủ tại kho) — bản standalone trên
        trình duyệt này KHÔNG bắn webhook ra ngoài. Cấu hình webhook tại server qua API
        /api/webhooks (quyền webhooks_manage, chỉ quản trị kho).
      </Notice>
      <Card>
        <h3 className="mb-2 font-semibold">Sự kiện được hỗ trợ</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><code>shipment.shipped</code> — khi một đơn xuất được giao (tạo phiếu giao).</li>
          <li><code>po.received</code> — khi một PO nhận đủ và chuyển trạng thái RECEIVED.</li>
          <li><code>alert.critical</code> — sau mỗi lần quét cảnh báo, nếu có cảnh báo CRITICAL mới.</li>
        </ul>
        <p className="mt-3 text-sm text-slate-600">
          Mỗi lần bắn, server gửi POST JSON <code>{'{ event, at, data }'}</code>; nếu cấu hình có
          secret, header <code>X-WareAxis-Signature</code> chứa HMAC-SHA256 của thân tin để phía
          nhận kiểm chứng. Lỗi webhook không làm hỏng nghiệp vụ chính — mọi lần bắn (kể cả lỗi)
          đều ghi vào nhật ký webhook trên server (GET /api/webhooks/log).
        </p>
      </Card>
    </div>
  )
}
