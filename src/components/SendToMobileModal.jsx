import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CENTRE } from '../data/seed'
import { api } from '../live/api'
import * as I from './Icons'
import { Modal } from './ui'

const EXPIRY = [
  { v: 24, label: '24 hours' },
  { v: 72, label: '3 days' },
  { v: 168, label: '7 days' },
  { v: 720, label: '30 days' },
]

export const DEMO_SHARE_OTP = '739104'

/** India by default: 10 digits starting 6–9 become +91XXXXXXXXXX; anything with + is kept. */
export function normaliseMobile(input) {
  const raw = String(input || '').replace(/[\s()-]/g, '')
  if (/^\+\d{8,15}$/.test(raw)) return raw
  const digits = raw.replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null
}

const smsText = ({ study, includeReport, link, hours, otp }) =>
  `${CENTRE.name.split(' —')[0]}: your ${study.modality} ${study.bodyPart} images${includeReport ? ' and report are' : ' are'} ready. View: ${link}${otp ? ' OTP sent separately' : ''}. Valid ${EXPIRY.find((e) => e.v === hours)?.label || `${hours} h`}.`

/**
 * Staff send a study to any mobile number: images at any time, the report only once
 * it is signed. The link expires, can require an OTP, and every send is audited.
 */
export default function SendToMobileModal({ open, onClose, study, defaultIncludeReport = false }) {
  const { live, user, updateStudy, pushEvent, refreshStudy, toast, navigate, setPatientLink } = useStore()
  const signed = Boolean(study.report)
  const [mobile, setMobile] = useState('')
  const [includeReport, setIncludeReport] = useState(false)
  const [hours, setHours] = useState(72)
  const [requireOtp, setRequireOtp] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(null)

  useEffect(() => {
    if (!open) return
    setMobile(study.patient.phone || '')
    setIncludeReport(signed && defaultIncludeReport)
    setSent(null)
    setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const to = normaliseMobile(mobile)

  const send = async () => {
    setError('')
    if (!to) return setError('Enter a valid mobile number, e.g. 98765 43210 or +44 7700 900123.')
    if (includeReport && !signed) return setError('The report is not signed yet.')
    setBusy(true)
    try {
      if (live) {
        const r = await api(`/studies/${study.id}/shares`, { method: 'POST', body: { mobile: to, includeReport, expiresHours: hours, requireOtp } })
        await refreshStudy(study.id)
        setSent({ to: r.share.to || to, link: r.share.url, message: r.message, includeReport })
      } else {
        // demo: same record shape as the gateway, delivered instantly
        const token = Math.random().toString(36).slice(2, 10)
        const link = `${location.origin}${location.pathname}#/s/${token}`
        const at = new Date().toISOString()
        const share = { id: `sh_${token}`, token, channel: 'sms', to, at, status: 'delivered', includeReport, requireOtp, expiresAt: new Date(Date.now() + hours * 3600e3).toISOString(), revoked: false }
        updateStudy(study.id, (s) => ({ ...s, shares: [...s.shares, share], status: includeReport ? 'shared' : s.status }))
        pushEvent(study.id, `Sent ${includeReport ? 'images and report' : 'images'} to ${to} by SMS — link valid ${EXPIRY.find((e) => e.v === hours).label}${requireOtp ? ', OTP protected' : ''}`, 'share', user.name)
        if (includeReport) setPatientLink(study.id)
        setSent({ to, link, token, message: smsText({ study, includeReport, link, hours, otp: requireOtp }), includeReport })
      }
      toast(`Sent to ${to}`, 'success', includeReport ? 'Images and report' : 'Images only')
    } catch (e) {
      setError(e.status === 409 ? 'The report is not signed yet — send images only, or wait for the radiologist.' : e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={sent ? 'Sent' : 'Send to a mobile number'} subtitle={`${study.patient.name} · ${study.id} · ${study.modality} ${study.bodyPart}`} icon={<I.Phone size={19} />}>
      {sent ? (
        <div className="p-6">
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex gap-3">
            <I.CheckCircle size={20} className="text-emerald-600 shrink-0" />
            <div>
              <p className="text-[13.5px] font-medium text-emerald-900">
                {sent.includeReport ? 'Images and report' : 'Images'} sent to <span className="font-mono">{sent.to}</span>
              </p>
              <p className="text-[12.5px] text-emerald-800/80 mt-0.5">Recorded in the study's audit trail. You can revoke the link from the Delivery tab.</p>
            </div>
          </div>
          <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mt-5 mb-1.5">SMS</p>
          <div className="rounded-2xl bg-slate-100 px-4 py-3 text-[13px] text-slate-700 leading-relaxed">{sent.message}</div>
          {!live && requireOtp && <p className="text-[12px] text-slate-400 mt-2">Demo: the recipient's OTP is {DEMO_SHARE_OTP}.</p>}
          <div className="mt-6 flex gap-2.5">
            <button onClick={() => setSent(null)} className="btn-outline btn-lg flex-1">
              Send to another number
            </button>
            {!live ? (
              <button
                onClick={() => {
                  onClose()
                  navigate('share-link', { token: sent.token })
                }}
                className="btn-primary btn-lg flex-1"
              >
                Open as recipient
              </button>
            ) : (
              <button onClick={onClose} className="btn-primary btn-lg flex-1">
                Done
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="p-6 space-y-5">
          <div>
            <label className="label">Mobile number</label>
            <input
              className="input font-mono"
              inputMode="tel"
              placeholder="98765 43210"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              autoFocus
            />
            <p className="text-[12px] text-slate-400 mt-1.5">
              {to ? <>Will send to <span className="font-mono text-slate-600">{to}</span></> : 'Patient, relative or referring doctor — any number. India (+91) is assumed without a country code.'}
            </p>
          </div>

          <div className="grid gap-2.5">
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
              <input type="checkbox" checked readOnly className="mt-1 accent-brand-600" />
              <span>
                <span className="text-[13.5px] font-medium text-slate-800">Scan images</span>
                <span className="block text-[12px] text-slate-500">{study.images} images, viewable in the browser — available now</span>
              </span>
            </label>
            <label className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${signed ? 'border-slate-200' : 'border-slate-100 bg-slate-50 opacity-70'}`}>
              <input type="checkbox" checked={includeReport} disabled={!signed} onChange={(e) => setIncludeReport(e.target.checked)} className="mt-1 accent-brand-600" />
              <span>
                <span className="text-[13.5px] font-medium text-slate-800">Radiology report</span>
                <span className="block text-[12px] text-slate-500">
                  {signed ? `Signed by ${study.report.signedBy}` : 'Not signed yet — it can be sent once the radiologist signs it'}
                </span>
              </span>
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Link valid for</label>
              <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {EXPIRY.map((e) => (
                  <option key={e.v} value={e.v}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2.5 mt-6 text-[13px] text-slate-700">
              <input type="checkbox" checked={requireOtp} onChange={(e) => setRequireOtp(e.target.checked)} className="accent-brand-600" />
              Require a one-time code (OTP) to open
            </label>
          </div>

          {error && <p className="text-[12.5px] text-rose-600">{error}</p>}

          <div className="flex gap-2.5 pt-1">
            <button onClick={onClose} className="btn-ghost btn-lg flex-1" disabled={busy}>
              Cancel
            </button>
            <button onClick={send} className="btn-primary btn-lg flex-1" disabled={busy || !to}>
              <I.Send size={16} /> {busy ? 'Sending…' : 'Send SMS'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
