import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import * as I from './Icons'
import { Modal, Progress } from './ui'

const EXPIRY = [
  { v: 24, label: '24 hours' },
  { v: 72, label: '3 days' },
  { v: 168, label: '7 days' },
  { v: 720, label: '30 days' },
]

const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', sub: 'Utility template message', icon: I.Whatsapp, tint: 'text-emerald-600 bg-emerald-50' },
  { key: 'sms', label: 'SMS', sub: 'Transactional route, DLT approved', icon: I.Phone, tint: 'text-sky-600 bg-sky-50' },
  { key: 'email', label: 'Email', sub: 'Secure link, no attachment', icon: I.Mail, tint: 'text-violet-600 bg-violet-50' },
]

export default function ShareModal({ open, onClose, study }) {
  const { updateStudy, pushEvent, notify, toast, setPatientLink, switchRole } = useStore()
  const [sel, setSel] = useState({ whatsapp: true, sms: true, email: true })
  const [expiry, setExpiry] = useState(168)
  const [otpLock, setOtpLock] = useState(true)
  const [phase, setPhase] = useState('compose') // compose | sending | sent
  const [progress, setProgress] = useState({})
  const [copied, setCopied] = useState(false)

  const link = useMemo(() => `https://reports.asvanta.in/r/${study.id.replace('STD-', '').toLowerCase()}k29xq`, [study.id])

  useEffect(() => {
    if (!open) {
      setPhase('compose')
      setProgress({})
      setCopied(false)
    }
  }, [open])

  const chosen = CHANNELS.filter((c) => sel[c.key])

  const send = () => {
    if (!chosen.length) return
    setPhase('sending')
    const statuses = {}
    chosen.forEach((c) => (statuses[c.key] = 'queued'))
    setProgress({ ...statuses })

    chosen.forEach((c, i) => {
      setTimeout(() => setProgress((p) => ({ ...p, [c.key]: 'sent' })), 500 + i * 350)
      setTimeout(() => setProgress((p) => ({ ...p, [c.key]: 'delivered' })), 1200 + i * 350)
    })

    const total = 1600 + chosen.length * 350
    setTimeout(() => {
      const at = new Date().toISOString()
      updateStudy(study.id, (s) => ({
        ...s,
        status: 'shared',
        shares: [
          ...s.shares,
          ...chosen.map((c) => ({
            channel: c.key,
            to: c.key === 'email' ? study.patient.email || '—' : study.patient.phone,
            at,
            status: 'delivered',
          })),
        ],
        linkExpiryHours: expiry,
        otpLock,
      }))
      pushEvent(
        study.id,
        `Report published to patient — link sent via ${chosen.map((c) => c.label).join(', ')}, valid ${EXPIRY.find((e) => e.v === expiry).label}${otpLock ? ', OTP protected' : ''}`,
        'share',
        'Priya Sharma'
      )
      notify({ title: 'Report published', body: `${study.id} — link sent to ${study.patient.name} on ${chosen.map((c) => c.label).join(', ')}.`, kind: 'share' })
      setPatientLink(study.id)
      setPhase('sent')
      toast('Report published', 'success', `${study.patient.name} can now open the report.`)
    }, total)
  }

  const waText = `Hello ${study.patient.name.split(' ')[0]}, your ${study.modality} ${study.bodyPart} report from Asvanta Diagnostics is ready. View it securely here: ${link} (link valid ${EXPIRY.find((e) => e.v === expiry).label})`
  const smsText = `Asvanta: Your ${study.modality} report (${study.id}) is ready. Open ${link} — valid ${EXPIRY.find((e) => e.v === expiry).label}. Do not share this link.`

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-3xl"
      title={phase === 'sent' ? 'Report published' : 'Publish report to patient'}
      subtitle={`${study.patient.name} · ${study.id} · ${study.modality} ${study.bodyPart}`}
      icon={<I.Share size={19} />}
    >
      {phase === 'sent' ? (
        <div className="p-6">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-5 flex items-start gap-3.5">
            <div className="h-11 w-11 rounded-xl bg-emerald-500 text-white grid place-items-center shrink-0">
              <I.Check size={21} />
            </div>
            <div>
              <p className="font-semibold text-emerald-900">Published on {chosen.length} channel{chosen.length > 1 ? 's' : ''}</p>
              <p className="text-[13px] text-emerald-800/80 mt-1 leading-relaxed">
                {study.patient.name} receives a link that opens the report and images in a browser — nothing large is attached to the message.
                The link stops working after {EXPIRY.find((e) => e.v === expiry).label}{otpLock ? ' and asks for an OTP first' : ''}.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            {chosen.map((c) => (
              <div key={c.key} className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <div className={`h-9 w-9 rounded-lg grid place-items-center ${c.tint}`}>
                  <c.icon size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-slate-800">{c.label}</p>
                  <p className="text-[12.5px] text-slate-500 truncate">{c.key === 'email' ? study.patient.email || '—' : study.patient.phone}</p>
                </div>
                <span className="chip bg-emerald-50 text-emerald-700">
                  <I.Check size={12} /> Delivered
                </span>
              </div>
            ))}
          </div>

          <div className="mt-6 flex gap-2.5">
            <button
              onClick={() => {
                onClose()
                switchRole('patient')
              }}
              className="btn-primary btn-lg flex-1"
            >
              <I.Eye size={17} /> See what the patient sees
            </button>
            <button onClick={onClose} className="btn-outline btn-lg">
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          {/* left: options */}
          <div className="p-6">
            <p className="label">Channels</p>
            <div className="space-y-2">
              {CHANNELS.map((c) => {
                const on = sel[c.key]
                const st = progress[c.key]
                const disabled = c.key === 'email' && !study.patient.email
                return (
                  <button
                    key={c.key}
                    disabled={phase === 'sending' || disabled}
                    onClick={() => setSel((s) => ({ ...s, [c.key]: !s[c.key] }))}
                    className={`w-full text-left rounded-xl border p-3 flex items-center gap-3 transition disabled:opacity-50 ${
                      on ? 'border-brand-500 bg-brand-50/50 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${c.tint}`}>
                      <c.icon size={17} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-slate-800">{c.label}</p>
                      <p className="text-[12px] text-slate-500 truncate">
                        {disabled ? 'No email on file' : c.key === 'email' ? study.patient.email : c.sub}
                      </p>
                    </div>
                    {st ? (
                      <span className={`chip !text-[11px] ${st === 'delivered' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                        {st === 'delivered' ? <I.Check size={11} /> : <I.Clock size={11} />} {st}
                      </span>
                    ) : (
                      <div className={`h-5 w-5 rounded-md border-2 grid place-items-center shrink-0 ${on ? 'bg-brand-600 border-brand-600' : 'border-slate-300'}`}>
                        {on && <I.Check size={12} className="text-white" />}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="mt-5">
              <p className="label">Link expires after</p>
              <div className="grid grid-cols-4 gap-2">
                {EXPIRY.map((e) => (
                  <button
                    key={e.v}
                    disabled={phase === 'sending'}
                    onClick={() => setExpiry(e.v)}
                    className={`h-10 rounded-xl border text-[12.5px] font-medium transition ${
                      expiry === e.v ? 'border-brand-500 bg-brand-50 text-brand-700 ring-4 ring-brand-500/10' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              disabled={phase === 'sending'}
              onClick={() => setOtpLock((v) => !v)}
              className="mt-4 w-full flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-slate-300 transition"
            >
              <div className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${otpLock ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400'}`}>
                <I.Lock size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-slate-800">Ask for an OTP before opening</p>
                <p className="text-[12px] text-slate-500">Sent to {study.patient.phone}</p>
              </div>
              <div className={`h-6 w-10 rounded-full p-0.5 transition ${otpLock ? 'bg-brand-600' : 'bg-slate-200'}`}>
                <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${otpLock ? 'translate-x-4' : ''}`} />
              </div>
            </button>

            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-100 p-3">
              <p className="text-[11.5px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">Secure link</p>
              <div className="flex items-center gap-2">
                <code className="text-[12px] text-slate-700 truncate flex-1">{link}</code>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(link)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1800)
                  }}
                  className="btn-ghost h-7 w-7 rounded-lg shrink-0"
                >
                  {copied ? <I.Check size={14} className="text-emerald-600" /> : <I.Copy size={14} />}
                </button>
              </div>
            </div>
          </div>

          {/* right: previews */}
          <div className="p-6 bg-slate-50/40">
            <p className="label">Message preview</p>

            {sel.whatsapp && (
              <div className="mb-3 animate-fade-up">
                <div className="flex items-center gap-1.5 mb-1.5 text-[11.5px] font-medium text-emerald-700">
                  <I.Whatsapp size={13} /> WhatsApp · Utility
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-white border border-slate-200 p-3 shadow-sm">
                  <p className="text-[12.5px] text-slate-700 leading-relaxed">{waText}</p>
                  <p className="text-[10.5px] text-slate-400 mt-2 text-right">now ✓✓</p>
                </div>
              </div>
            )}

            {sel.sms && (
              <div className="mb-3 animate-fade-up">
                <div className="flex items-center gap-1.5 mb-1.5 text-[11.5px] font-medium text-sky-700">
                  <I.Phone size={13} /> SMS · Transactional
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-white border border-slate-200 p-3 shadow-sm">
                  <p className="text-[12.5px] text-slate-700 leading-relaxed">{smsText}</p>
                </div>
              </div>
            )}

            {sel.email && study.patient.email && (
              <div className="animate-fade-up">
                <div className="flex items-center gap-1.5 mb-1.5 text-[11.5px] font-medium text-violet-700">
                  <I.Mail size={13} /> Email · Transactional
                </div>
                <div className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/60">
                    <p className="text-[11.5px] text-slate-500">To: {study.patient.email}</p>
                    <p className="text-[12.5px] font-medium text-slate-800">Your {study.modality} report is ready</p>
                  </div>
                  <div className="p-3">
                    <p className="text-[12.5px] text-slate-600 leading-relaxed">
                      Dear {study.patient.name.split(' ')[0]},<br />
                      Your report for {study.modality} — {study.bodyPart} (study {study.id}) has been signed by our radiologist.
                    </p>
                    <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 text-white text-[12px] font-medium px-3 py-1.5">
                      View report securely <I.ArrowRight size={12} />
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2.5">Images are not attached. The link opens the report in your browser.</p>
                  </div>
                </div>
              </div>
            )}

            {!chosen.length && (
              <p className="text-[13px] text-slate-400 py-8 text-center">Pick at least one channel to see the message.</p>
            )}
          </div>
        </div>
      )}

      {phase !== 'sent' && (
        <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3">
          <p className="text-[12px] text-slate-400 flex-1">
            {phase === 'sending' ? 'Delivering…' : `${chosen.length} channel${chosen.length === 1 ? '' : 's'} selected`}
          </p>
          <button onClick={onClose} className="btn-ghost btn-md" disabled={phase === 'sending'}>
            Cancel
          </button>
          <button onClick={send} className="btn-primary btn-md" disabled={!chosen.length || phase === 'sending'}>
            {phase === 'sending' ? 'Sending…' : 'Send secure link'} {phase !== 'sending' && <I.Send size={16} />}
          </button>
        </div>
      )}
      {phase === 'sending' && <Progress value={60} className="!h-1 rounded-none" />}
    </Modal>
  )
}
