import { useState } from 'react'
import { Field, Notice, inputClass } from '../../shared/ui/ui'
import { FormDialog } from '../../shared/ui/FormDialog'
import { upsertMyAccountProfile, freightAcctErrText, type AccountProfile } from '../../shared/supabase/freightAccount'
import { validateAccountProfile } from '../../domain/freight/account'
import { SELF_DECLARED_LABEL } from '../../domain/freight/profile'
import { strOrNull } from './shared'

/**
 * Dialog đăng ký / sửa hồ sơ tài khoản (dùng chung một dialog — thiết kế
 * 2.4.2). Một tài khoản có MỘT hồ sơ duy nhất với hai vai trò độc lập:
 * chủ kho và vận tải. Validate mềm phía client + RPC freight_acct_*.
 */
export function ProfileDialog({
  initial,
  presetRole,
  defaultDisplayName,
  onClose,
  onSaved,
}: {
  initial: AccountProfile | null
  presetRole?: 'shipper' | 'carrier'
  defaultDisplayName?: string
  onClose: () => void
  onSaved: (p: AccountProfile) => void
}) {
  const [displayName, setDisplayName] = useState(initial?.display_name ?? defaultDisplayName ?? '')
  const [legalName, setLegalName] = useState(initial?.legal_name ?? '')
  const [taxCode, setTaxCode] = useState(initial?.tax_code ?? '')
  const [contactName, setContactName] = useState(initial?.contact_name ?? '')
  const [contactPhone, setContactPhone] = useState(initial?.contact_phone ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [province, setProvince] = useState(initial?.province ?? '')
  const [isShipper, setIsShipper] = useState(initial?.is_shipper ?? presetRole === 'shipper')
  const [isCarrier, setIsCarrier] = useState(initial?.is_carrier ?? presetRole === 'carrier')
  const [licenseNo, setLicenseNo] = useState(initial?.business_license_no ?? '')
  const [capability, setCapability] = useState(initial?.capability_note ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const input = {
      display_name: displayName.trim(),
      legal_name: strOrNull(legalName),
      tax_code: strOrNull(taxCode),
      contact_name: strOrNull(contactName),
      contact_phone: strOrNull(contactPhone),
      address: strOrNull(address),
      province: strOrNull(province),
      is_shipper: isShipper,
      is_carrier: isCarrier,
      business_license_no: strOrNull(licenseNo),
      capability_note: strOrNull(capability),
    }
    const v = validateAccountProfile(input)
    if (v.length) {
      setErr(v.join(' '))
      return
    }
    setBusy(true)
    setErr('')
    try {
      const saved = await upsertMyAccountProfile({
        displayName: input.display_name,
        legalName: input.legal_name,
        taxCode: input.tax_code,
        contactName: input.contact_name,
        contactPhone: input.contact_phone,
        address: input.address,
        province: input.province,
        isShipper,
        isCarrier,
        businessLicenseNo: input.business_license_no,
        capabilityNote: input.capability_note,
      })
      onSaved(saved)
    } catch (e) {
      setErr(freightAcctErrText(e))
      setBusy(false)
    }
  }

  return (
    <FormDialog
      title={initial ? 'Sửa hồ sơ của tôi' : 'Đăng ký hồ sơ của tôi'}
      onClose={onClose}
      onSubmit={submit}
      submitText="Lưu hồ sơ"
      busy={busy}
      error={err}
    >
      <Notice kind="warn">{SELF_DECLARED_LABEL}</Notice>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tên hiển thị *">
          <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Tỉnh/TP">
          <input className={inputClass} value={province} onChange={(e) => setProvince(e.target.value)} />
        </Field>
        <Field label="Tên pháp nhân (nếu có)">
          <input className={inputClass} value={legalName} onChange={(e) => setLegalName(e.target.value)} />
        </Field>
        <Field label="Mã số thuế">
          <input className={inputClass} value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
        </Field>
        <Field label="Người liên hệ">
          <input className={inputClass} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Điện thoại liên hệ">
          <input className={inputClass} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} inputMode="tel" />
        </Field>
      </div>
      <Field label="Địa chỉ">
        <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <div className="space-y-2">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={isShipper} onChange={(e) => setIsShipper(e.target.checked)} />
          <span>Tôi là chủ kho / chủ hàng (đăng tải tìm xe, quản lý các kho của tôi)</span>
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={isCarrier} onChange={(e) => setIsCarrier(e.target.checked)} />
          <span>Tôi đăng ký vận tải (có đội xe, nhận chuyến)</span>
        </label>
      </div>
      {isCarrier && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Số giấy phép kinh doanh vận tải (tự khai, nếu có)">
            <input className={inputClass} value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} />
          </Field>
          <Field label="Mô tả năng lực (khu vực mạnh, loại hàng nhận…)">
            <input className={inputClass} value={capability} onChange={(e) => setCapability(e.target.value)} />
          </Field>
        </div>
      )}
    </FormDialog>
  )
}
