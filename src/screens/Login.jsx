import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { CENTRE, USERS } from '../data/seed'
import * as I from '../components/Icons'

const DEMO_OTP = '482913'

const ACCOUNTS = [
  { role: 'staff', label: 'Centre Staff', hint: 'Receives scans from machines, shares studies' },
  { role: 'radiologist', label: 'Radiologist', hint: 'Reads studies, signs reports' },
]

export default function Login() {
  const { login, toast, switchRole, live, liveLogin } = useStore()
  const [step, setStep] = useState('credentials') // credentials | otp | centre
  const [role, setRole] = useState('staff')
  const [email, setEmail] = useState(USERS.staff.email)
  const [password, setPassword] = useState(live ? '' : 'demo1234')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(30)
  const boxes = useRef([])

  useEffect(() => setEmail(USERS[role].email), [role])

  useEffect(() => {
    if (step !== 'otp') return
    boxes.current[0]?.focus()
    setSeconds(30)
    const t = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [step])

  const submitCredentials = (e) => {
    e.preventDefault()
    setError('')
    if (!email || password.length < 4) return setError('Enter your email and password to continue.')
    setBusy(true)
    if (live) {
      // the gateway checks the password; there is no simulated OTP step against a real server
      liveLogin(email, password)
        .then((u) => toast(`Signed in as ${u.name}`, 'success', CENTRE.name))
        .catch((err) => {
          setBusy(false)
          setError(err.status === 401 ? 'Email or password is incorrect.' : `Could not reach the server: ${err.message}`)
        })
      return
    }
    setTimeout(() => {
      setBusy(false)
      setStep('otp')
      toast(`OTP sent to ${USERS[role].phone}`, 'info', 'Delivered over SMS. Demo code is 482913.')
    }, 700)
  }

  const onOtpChange = (i, v) => {
    if (!/^\d?$/.test(v)) return
    const next = [...otp]
    next[i] = v
    setOtp(next)
    setError('')
    if (v && i < 5) boxes.current[i + 1]?.focus()
  }

  const onOtpKey = (i, e) => {
    if (e.key === 'Backspace' && !otp[i] && i > 0) boxes.current[i - 1]?.focus()
    if (e.key === 'ArrowLeft' && i > 0) boxes.current[i - 1]?.focus()
    if (e.key === 'ArrowRight' && i < 5) boxes.current[i + 1]?.focus()
  }

  const onOtpPaste = (e) => {
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6)
    if (!text) return
    e.preventDefault()
    const next = ['', '', '', '', '', '']
    text.split('').forEach((c, idx) => (next[idx] = c))
    setOtp(next)
    boxes.current[Math.min(text.length, 5)]?.focus()
  }

  const submitOtp = (e) => {
    e.preventDefault()
    const code = otp.join('')
    if (code.length < 6) return setError('Enter all six digits.')
    if (code !== DEMO_OTP) return setError('That code is incorrect. For this demo, use 482913.')
    setBusy(true)
    setTimeout(() => {
      setBusy(false)
      setStep('centre')
    }, 650)
  }

  const enterCentre = () => {
    setBusy(true)
    setTimeout(() => {
      login(role)
      toast(`Signed in as ${USERS[role].name}`, 'success', `${CENTRE.name}`)
    }, 500)
  }

  return (
    <div className="min-h-screen flex">
      {/* Left — brand panel */}
      <div className="hidden lg:flex w-[46%] xl:w-[42%] relative bg-gradient-to-br from-brand-700 via-brand-600 to-brand-800 text-white flex-col justify-between p-12 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.18] grid-bg" />
        <div className="absolute -right-24 -top-24 h-[380px] w-[380px] rounded-full bg-white/10 blur-3xl" />
        <div className="absolute -left-20 bottom-0 h-[300px] w-[300px] rounded-full bg-sky-300/10 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-white/15 backdrop-blur grid place-items-center">
            <I.Logo size={26} />
          </div>
          <div>
            <p className="font-semibold text-lg tracking-tight">Asvanta</p>
            <p className="text-[11px] text-brand-100 uppercase tracking-widest">Diagnostic Platform</p>
          </div>
        </div>

        <div className="relative">
          <h2 className="text-[34px] leading-[1.15] font-semibold tracking-tight">
            From scan to patient,<br />in one secure trail.
          </h2>
          <p className="mt-4 text-brand-100/90 text-[15px] leading-relaxed max-w-md">
            Register the patient, upload the study straight to encrypted storage, report it, and deliver a secure link — every step logged.
          </p>

          <div className="mt-9 space-y-3.5">
            {[
              { icon: I.Cloud, t: 'Direct-to-storage uploads', s: 'Large DICOM files never pass through the app server' },
              { icon: I.Lock, t: 'Private by default', s: 'Time-limited links; no public image URLs' },
              { icon: I.Clock, t: '365-day retention', s: 'Images expire automatically on schedule' },
            ].map((f) => (
              <div key={f.t} className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-white/12 backdrop-blur grid place-items-center shrink-0">
                  <f.icon size={17} />
                </div>
                <div>
                  <p className="text-[14px] font-medium">{f.t}</p>
                  <p className="text-[12.5px] text-brand-100/75">{f.s}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[12px] text-brand-100/60">© 2026 Asvanta Health Technologies</p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 bg-white">
        <div className="w-full max-w-[400px]">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <I.Logo size={32} />
            <p className="font-semibold text-lg text-slate-900">Asvanta</p>
          </div>

          {/* Step indicator */}
          <div className="flex items-center gap-2 mb-8">
            {['credentials', 'otp', 'centre'].map((s, i) => {
              const order = ['credentials', 'otp', 'centre']
              const done = order.indexOf(step) > i
              const active = step === s
              return (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div
                    className={`h-6 w-6 rounded-full grid place-items-center text-[11px] font-semibold transition ${
                      done ? 'bg-emerald-500 text-white' : active ? 'bg-brand-600 text-white animate-pulse-ring' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {done ? <I.Check size={12} /> : i + 1}
                  </div>
                  {i < 2 && <div className={`h-0.5 flex-1 rounded ${done ? 'bg-emerald-400' : 'bg-slate-100'}`} />}
                </div>
              )
            })}
          </div>

          {step === 'credentials' && (
            <form onSubmit={submitCredentials} className="animate-fade-up">
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Sign in</h1>
              <p className="text-slate-500 text-[14px] mt-1.5">Step 1 of 3 — verify your credentials.</p>

              <div className="mt-7 space-y-4">
                <div>
                  <label className="label">I am signing in as</label>
                  <div className="grid grid-cols-2 gap-2">
                    {ACCOUNTS.map((a) => (
                      <button
                        key={a.role}
                        type="button"
                        onClick={() => setRole(a.role)}
                        className={`text-left rounded-xl border p-3 transition ${
                          role === a.role ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <p className="text-[13px] font-medium text-slate-800">{a.label}</p>
                        <p className="text-[11.5px] text-slate-500 leading-snug mt-0.5">{a.hint}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="label">Work email</label>
                  <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@asvanta.in" />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="label !mb-0">Password</label>
                    <button type="button" className="text-[12.5px] text-brand-600 font-medium hover:underline">Forgot?</button>
                  </div>
                  <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                </div>

                {error && (
                  <p className="text-[13px] text-rose-600 flex items-center gap-1.5">
                    <I.Alert size={14} /> {error}
                  </p>
                )}

                <button className="btn-primary btn-lg w-full" disabled={busy}>
                  {busy ? 'Verifying…' : 'Continue'} {!busy && <I.ArrowRight size={17} />}
                </button>
              </div>
            </form>
          )}

          {step === 'otp' && (
            <form onSubmit={submitOtp} className="animate-fade-up">
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Verify it's you</h1>
              <p className="text-slate-500 text-[14px] mt-1.5">
                Step 2 of 3 — we sent a 6-digit code to <span className="text-slate-700 font-medium">{USERS[role].phone}</span>.
              </p>

              <div className="mt-7">
                <div className="flex gap-2" onPaste={onOtpPaste}>
                  {otp.map((v, i) => (
                    <input
                      key={i}
                      ref={(el) => (boxes.current[i] = el)}
                      value={v}
                      onChange={(e) => onOtpChange(i, e.target.value)}
                      onKeyDown={(e) => onOtpKey(i, e)}
                      inputMode="numeric"
                      maxLength={1}
                      className="h-14 flex-1 min-w-0 rounded-xl border border-slate-200 text-center text-xl font-semibold text-slate-800 outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
                    />
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between text-[12.5px]">
                  <button type="button" onClick={() => setOtp(DEMO_OTP.split(''))} className="text-brand-600 font-medium hover:underline">
                    Autofill demo code
                  </button>
                  <span className="text-slate-400">{seconds > 0 ? `Resend in 0:${String(seconds).padStart(2, '0')}` : 'Resend code'}</span>
                </div>

                {error && (
                  <p className="text-[13px] text-rose-600 flex items-center gap-1.5 mt-3">
                    <I.Alert size={14} /> {error}
                  </p>
                )}

                <button className="btn-primary btn-lg w-full mt-5" disabled={busy}>
                  {busy ? 'Checking…' : 'Verify code'}
                </button>
                <button type="button" onClick={() => setStep('credentials')} className="btn-ghost btn-md w-full mt-2">
                  <I.ArrowLeft size={15} /> Back
                </button>
              </div>
            </form>
          )}

          {step === 'centre' && (
            <div className="animate-fade-up">
              <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Choose a centre</h1>
              <p className="text-slate-500 text-[14px] mt-1.5">Step 3 of 3 — your access is scoped to the centre you pick.</p>

              <div className="mt-7 space-y-2.5">
                <button className="w-full text-left rounded-2xl border border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10 p-4 flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl bg-brand-600 text-white grid place-items-center shrink-0">
                    <I.Building size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-slate-900 truncate">{CENTRE.name}</p>
                    <p className="text-[12.5px] text-slate-500">{CENTRE.code} · {CENTRE.city}</p>
                  </div>
                  <I.CheckCircle size={20} className="text-brand-600 shrink-0" />
                </button>

                <div className="w-full text-left rounded-2xl border border-slate-200 p-4 flex items-center gap-3 opacity-55">
                  <div className="h-11 w-11 rounded-xl bg-slate-100 text-slate-400 grid place-items-center shrink-0">
                    <I.Building size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-slate-700 truncate">Asvanta Diagnostics — Powai</p>
                    <p className="text-[12.5px] text-slate-400">AND-02 · No access</p>
                  </div>
                  <I.Lock size={17} className="text-slate-300 shrink-0" />
                </div>
              </div>

              <div className="mt-5 rounded-xl bg-slate-50 border border-slate-100 p-3.5 flex gap-2.5">
                <I.Shield size={16} className="text-emerald-600 shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-slate-600 leading-relaxed">
                  Every study, upload and report you touch is recorded against this centre and your user ID.
                </p>
              </div>

              <button onClick={enterCentre} className="btn-primary btn-lg w-full mt-5" disabled={busy}>
                {busy ? 'Opening…' : `Enter as ${USERS[role].name}`}
              </button>
            </div>
          )}

          <div className="mt-8 pt-5 border-t border-slate-100 flex items-center justify-between">
            <p className="text-[12px] text-slate-400">Prototype — any password works.</p>
            <button
              onClick={() => switchRole('patient')}
              className="text-[12.5px] font-medium text-brand-600 hover:underline flex items-center gap-1"
            >
              I have a report link <I.ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
