import { useEffect, useRef, useState } from 'react'
import { DemoBar } from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import SeriesThumb from '../viewer/SeriesThumb'
import SimpleViewer from '../viewer/SimpleViewer'
import { buildSeries } from '../viewer/series'
import { dateTime, timeAgo } from '../lib/format'

const DEMO_OTP = '739104'

export default function PatientPortal() {
  const { state, getStudy, pushEvent, toast, switchRole } = useStore()
  const study = getStudy(state.patientLinkStudyId) || state.studies.find((s) => s.report)
  const [step, setStep] = useState('message') // message | otp | report
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState(null)
  const boxes = useRef([])
  const logged = useRef(false)

  useEffect(() => {
    if (step === 'otp') boxes.current[0]?.focus()
  }, [step])

  useEffect(() => {
    if (step === 'report' && study && !logged.current) {
      logged.current = true
      pushEvent(study.id, 'Patient opened the secure report link', 'view', study.patient.name)
    }
  }, [step, study, pushEvent])

  if (!study || !study.report) {
    return (
      <div className="h-screen flex flex-col bg-slate-50">
        <DemoBar />
        <div className="flex-1 grid place-items-center p-6">
          <div className="card p-8 max-w-md text-center">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-amber-50 text-amber-600 grid place-items-center mb-4">
              <I.Clock size={26} />
            </div>
            <h1 className="text-[18px] font-semibold text-slate-900">Your report isn't ready yet</h1>
            <p className="text-[13.5px] text-slate-500 mt-2 leading-relaxed">
              We'll send a WhatsApp message and an SMS the moment the radiologist signs it. Nothing to do until then.
            </p>
            <button onClick={() => switchRole('radiologist')} className="btn-outline btn-md mt-5">
              <I.Stethoscope size={16} /> Sign a report as the radiologist
            </button>
          </div>
        </div>
      </div>
    )
  }

  const series = study.images > 0 ? buildSeries(study) : []
  const link = `https://reports.asvanta.in/r/${study.id.replace('STD-', '').toLowerCase()}k29xq`
  const expiryHours = study.linkExpiryHours || 168

  const onOtpChange = (i, v) => {
    if (!/^\d?$/.test(v)) return
    const next = [...otp]
    next[i] = v
    setOtp(next)
    setError('')
    if (v && i < 5) boxes.current[i + 1]?.focus()
  }

  const verify = (e) => {
    e.preventDefault()
    if (otp.join('').length < 6) return setError('Enter all six digits.')
    if (otp.join('') !== DEMO_OTP) return setError('Incorrect code. For this demo, use 739104.')
    setBusy(true)
    setTimeout(() => {
      setBusy(false)
      setStep('report')
      toast('Report unlocked', 'success', 'This link stays valid for a limited time only.')
    }, 700)
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <DemoBar />

      <header className="h-16 shrink-0 bg-white border-b border-slate-200 flex items-center px-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <I.Logo size={30} />
          <div className="leading-tight">
            <p className="font-semibold text-slate-900 tracking-tight">Asvanta</p>
            <p className="text-[10.5px] text-slate-400 uppercase tracking-wider">Patient report</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[12.5px] text-slate-500">
          <I.Lock size={14} className="text-emerald-600" />
          <span className="hidden sm:inline">Secure connection</span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {/* Step 1 — the message */}
        {step === 'message' && (
          <div className="max-w-[420px] mx-auto px-5 py-10 animate-fade-up">
            <p className="text-center text-[13px] text-slate-500 mb-5">
              This is what {study.patient.name.split(' ')[0]} receives on their phone.
            </p>

            <div className="rounded-[28px] border-[6px] border-slate-800 bg-[#e7ded4] overflow-hidden shadow-xl">
              <div className="bg-emerald-700 text-white px-4 py-3 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-white/20 grid place-items-center">
                  <I.Logo size={22} />
                </div>
                <div>
                  <p className="text-[13.5px] font-medium">Asvanta Diagnostics</p>
                  <p className="text-[11px] text-emerald-100">Business account</p>
                </div>
              </div>

              <div className="p-4 space-y-2 min-h-[280px]">
                <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-sm bg-[#d9fdd3] p-3 shadow-sm">
                  <p className="text-[13px] text-slate-800 leading-relaxed">
                    Hello {study.patient.name.split(' ')[0]}, your {study.modality} {study.bodyPart} report from Asvanta Diagnostics is ready.
                  </p>
                  <button
                    onClick={() => setStep(study.otpLock === false ? 'report' : 'otp')}
                    className="mt-2 block text-[12.5px] text-brand-700 underline break-all text-left"
                  >
                    {link}
                  </button>
                  <p className="text-[11px] text-slate-500 mt-2">
                    Link valid for {expiryHours >= 24 ? `${Math.round(expiryHours / 24)} days` : `${expiryHours} hours`}. Please don't forward it.
                  </p>
                  <p className="text-[10px] text-slate-400 text-right mt-1">{timeAgo(study.shares[study.shares.length - 1]?.at || study.report.signedAt)} ✓✓</p>
                </div>
              </div>
            </div>

            <button onClick={() => setStep(study.otpLock === false ? 'report' : 'otp')} className="btn-primary btn-lg w-full mt-6">
              Tap the link <I.ArrowRight size={17} />
            </button>
            <p className="text-center text-[12px] text-slate-400 mt-3">
              The message carries a link only — no images or PDFs are attached.
            </p>
          </div>
        )}

        {/* Step 2 — OTP */}
        {step === 'otp' && (
          <div className="max-w-[400px] mx-auto px-5 py-14 animate-fade-up">
            <div className="card p-7">
              <div className="h-12 w-12 rounded-2xl bg-brand-50 text-brand-600 grid place-items-center mb-5">
                <I.Lock size={22} />
              </div>
              <h1 className="text-[20px] font-semibold text-slate-900 tracking-tight">Confirm it's you</h1>
              <p className="text-[13.5px] text-slate-500 mt-1.5 leading-relaxed">
                We sent a 6-digit code to {study.patient.phone.replace(/\d(?=\d{4})/g, '•')}. The report opens only after it's verified.
              </p>

              <form onSubmit={verify} className="mt-6">
                <div className="flex gap-2">
                  {otp.map((v, i) => (
                    <input
                      key={i}
                      ref={(el) => (boxes.current[i] = el)}
                      value={v}
                      onChange={(e) => onOtpChange(i, e.target.value)}
                      onKeyDown={(e) => e.key === 'Backspace' && !otp[i] && i > 0 && boxes.current[i - 1]?.focus()}
                      inputMode="numeric"
                      maxLength={1}
                      className="h-14 flex-1 min-w-0 rounded-xl border border-slate-200 text-center text-xl font-semibold text-slate-800 outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
                    />
                  ))}
                </div>
                <button type="button" onClick={() => setOtp(DEMO_OTP.split(''))} className="text-[12.5px] text-brand-600 font-medium hover:underline mt-3">
                  Autofill demo code
                </button>
                {error && (
                  <p className="text-[13px] text-rose-600 flex items-center gap-1.5 mt-3">
                    <I.Alert size={14} /> {error}
                  </p>
                )}
                <button className="btn-primary btn-lg w-full mt-5" disabled={busy}>
                  {busy ? 'Verifying…' : 'Open my report'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Step 3 — the report */}
        {step === 'report' && (
          <div className="max-w-[820px] mx-auto px-5 sm:px-6 py-7 animate-fade-up">
            <div className="rounded-2xl bg-brand-50 border border-brand-100 p-4 flex items-start gap-3 mb-5">
              <I.Clock size={17} className="text-brand-600 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-brand-900">
                  This link expires {expiryHours >= 24 ? `${Math.round(expiryHours / 24)} days` : `${expiryHours} hours`} after it was sent
                </p>
                <p className="text-[12.5px] text-brand-800/70 mt-0.5">
                  Download a copy if you need it later. Your images are kept by the centre for 365 days.
                </p>
              </div>
            </div>

            <div className="card overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100 flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold">Radiology report</p>
                  <h1 className="text-[20px] font-semibold text-slate-900 tracking-tight mt-1">
                    {study.modality} — {study.bodyPart}
                  </h1>
                  <p className="text-[13px] text-slate-500 mt-1">
                    {study.patient.name} · {study.patient.age}
                    {study.patient.gender} · {study.id}
                  </p>
                </div>
                <span className="chip bg-emerald-50 text-emerald-700">
                  <I.CheckCircle size={13} /> Signed report
                </span>
              </div>

              <div className="px-6 py-5 grid sm:grid-cols-3 gap-x-6 gap-y-3 border-b border-slate-100 bg-slate-50/50">
                {[
                  ['Referred by', study.referredBy],
                  ['Study date', dateTime(study.createdAt).split(',')[0]],
                  ['Reported by', study.report.signedBy],
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold">{k}</p>
                    <p className="text-[13px] text-slate-700 mt-0.5">{v}</p>
                  </div>
                ))}
              </div>

              <div className="px-6 py-6 space-y-6">
                <div>
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mb-2">Findings</p>
                  <p className="text-[14.5px] text-slate-700 leading-[1.75] whitespace-pre-line">{study.report.findings}</p>
                </div>
                <div className="rounded-xl bg-brand-50/60 border border-brand-100 p-4">
                  <p className="text-[11.5px] uppercase tracking-wider text-brand-700/70 font-semibold mb-1.5">Impression</p>
                  <p className="text-[14.5px] text-slate-800 font-medium leading-[1.7] whitespace-pre-line">{study.report.impression}</p>
                </div>
              </div>

              <div className="px-6 pb-6">
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-4">
                  <div className="h-11 w-11 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white text-[13px] font-semibold grid place-items-center">AM</div>
                  <div>
                    <p className="text-[13.5px] font-medium text-slate-800">{study.report.signedBy}</p>
                    <p className="text-[12px] text-slate-500">Consultant Radiologist, MD · Digitally signed {dateTime(study.report.signedAt)}</p>
                  </div>
                </div>
              </div>

              {study.images > 0 && (
                <div className="px-6 pb-6">
                  <p className="text-[13px] font-semibold text-slate-900 mb-3">Your images ({study.images} across {series.length} series)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {series.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => setViewer(s)}
                        className="group rounded-xl overflow-hidden border border-slate-200 hover:border-brand-400 hover:shadow-pop transition text-left"
                      >
                        <div className="relative aspect-square bg-black">
                          <SeriesThumb series={s} />
                          <div className="absolute inset-0 grid place-items-center bg-brand-600/0 group-hover:bg-brand-600/15 transition">
                            <span className="opacity-0 group-hover:opacity-100 transition rounded-full bg-white/95 text-brand-700 h-8 w-8 grid place-items-center">
                              <I.Eye size={15} />
                            </span>
                          </div>
                          <span className="absolute right-1.5 bottom-1 text-[10px] font-mono text-white/75">{s.count}</span>
                        </div>
                        <p className="text-[12px] text-slate-600 px-2 py-1.5 truncate">{s.name}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/60 flex flex-wrap gap-2.5">
                <button className="btn-primary btn-md">
                  <I.Download size={16} /> Download report (PDF)
                </button>
                <button className="btn-outline btn-md">
                  <I.Image size={16} /> Download images
                </button>
                <button className="btn-ghost btn-md ml-auto">
                  <I.Phone size={16} /> Call the centre
                </button>
              </div>
            </div>

            <div className="mt-5 flex items-start gap-2.5 px-1">
              <I.Shield size={15} className="text-slate-400 shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-slate-500 leading-relaxed">
                This page was opened with a one-time link tied to your mobile number. The centre can see that it was opened, but nobody else can reach it.
              </p>
            </div>
          </div>
        )}
      </main>

      {viewer && <SimpleViewer study={study} series={viewer} onClose={() => setViewer(null)} />}

    </div>
  )
}
