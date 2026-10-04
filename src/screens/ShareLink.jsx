import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { CENTRE } from '../data/seed'
import { api } from '../live/api'
import * as I from '../components/Icons'
import SimpleViewer from '../viewer/SimpleViewer'
import { buildSeries } from '../viewer/series'
import { dateTime } from '../lib/format'
import { DEMO_SHARE_OTP } from '../components/SendToMobileModal'

const mask = (m) => (m ? m.replace(/\d(?=\d{4})/g, '•') : '')

/**
 * What someone opens from the SMS: an OTP gate, then the images (simple viewer —
 * no diagnostic tools) and, if it was shared and is signed, the report.
 * Works against the gateway in live mode and against the demo store otherwise.
 */
export default function ShareLink({ token }) {
  const { live, state, pushEvent, navigate } = useStore()
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [otp, setOtp] = useState('')
  const [busy, setBusy] = useState(false)
  const [access, setAccess] = useState(null)
  const [study, setStudy] = useState(null)
  const [viewer, setViewer] = useState(null)

  // demo: the share lives on a study in the local store
  const demo = useMemo(() => {
    if (live) return null
    for (const s of state.studies) {
      const sh = (s.shares || []).find((x) => x.token === token)
      if (sh) return { study: s, share: sh }
    }
    return null
  }, [live, state.studies, token])

  useEffect(() => {
    if (live) {
      api(`/s/${token}`, { auth: null })
        .then(setInfo)
        .catch((e) => setError(e.status === 404 ? 'This link is not valid.' : e.message))
    } else if (demo) {
      const expired = new Date(demo.share.expiresAt) < new Date()
      setInfo({
        centre: CENTRE.name,
        modality: demo.study.modality,
        bodyPart: demo.study.bodyPart,
        studyDate: demo.study.createdAt,
        mobileMasked: mask(demo.share.to),
        requiresOtp: demo.share.requireOtp,
        includeReport: demo.share.includeReport,
        expiresAt: demo.share.expiresAt,
        state: demo.share.revoked ? 'revoked' : expired ? 'expired' : 'active',
      })
    } else setError('This link is not valid.')
  }, [live, token, demo])

  const open = async (code) => {
    setBusy(true)
    setError('')
    try {
      if (live) {
        const { accessToken } = await api(`/s/${token}/otp/verify`, { method: 'POST', body: { otp: code ?? null }, auth: null })
        const s = await api(`/s/${token}/study`, { auth: accessToken })
        setAccess(accessToken)
        setStudy({
          ...s,
          id: `share-${token}`,
          source: 'pacs',
          seriesList: s.series,
          dicomwebBase: `/s/${token}/dicomweb`,
          dicomwebAuth: accessToken,
          images: s.series.reduce((a, x) => a + x.count, 0),
        })
      } else {
        if (demo.share.requireOtp && code !== DEMO_SHARE_OTP) throw new Error(`That code is incorrect. For this demo, use ${DEMO_SHARE_OTP}.`)
        const s = demo.study
        pushEvent(s.id, `Shared link opened by ${demo.share.to}`, 'view', demo.share.to)
        setStudy({
          ...s,
          patientName: s.patient.name,
          studyDate: s.createdAt,
          report: demo.share.includeReport ? s.report : null,
        })
        setAccess('demo')
      }
    } catch (e) {
      const left = e.body?.detail?.attemptsLeft
      setError(
        e.status === 423
          ? 'Too many wrong codes — this link is locked. Ask the centre to send a new one.'
          : e.status === 401 && left != null
            ? `That code is incorrect — ${left} attempt${left === 1 ? '' : 's'} left.`
            : e.status === 410
              ? 'This link has expired or was withdrawn.'
              : e.message
      )
    } finally {
      setBusy(false)
    }
  }

  const series = useMemo(() => (study ? buildSeries(study) : []), [study])

  const shell = (children) => (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-2.5">
          <I.Logo size={28} />
          <div>
            <p className="text-[13.5px] font-semibold text-slate-900 leading-tight">{info?.centre || CENTRE.name}</p>
            <p className="text-[10.5px] text-slate-400 uppercase tracking-wider">Secure scan link</p>
          </div>
          {!live && demo && (
            <button onClick={() => navigate('study', { id: demo.study.id })} className="ml-auto btn-ghost btn-sm">
              <I.ArrowLeft size={14} /> Back to the centre view
            </button>
          )}
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">{children}</main>
    </div>
  )

  if (error && !info) return shell(<div className="card p-6 text-center text-[14px] text-slate-600">{error}</div>)
  if (!info) return shell(<div className="card p-6 text-center text-[13px] text-slate-400">Opening…</div>)
  if (info.state !== 'active') {
    const text = { expired: 'This link has expired.', revoked: 'This link was withdrawn by the centre.', locked: 'This link is locked after too many wrong codes.' }[info.state]
    return shell(
      <div className="card p-6 text-center">
        <p className="text-[15px] font-semibold text-slate-900">{text}</p>
        <p className="text-[13px] text-slate-500 mt-1">Contact {info.centre} for a new link.</p>
      </div>
    )
  }

  if (!access) {
    return shell(
      <div className="card p-6">
        <h1 className="text-[18px] font-semibold text-slate-900">
          {info.modality} {info.bodyPart}
        </h1>
        <p className="text-[13px] text-slate-500 mt-1">
          {info.includeReport ? 'Scan images and report' : 'Scan images'} · {dateTime(info.studyDate)} · valid until {dateTime(info.expiresAt)}
        </p>
        {info.requiresOtp ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              open(otp)
            }}
            className="mt-6"
          >
            <label className="label">Enter the 6-digit code sent to {info.mobileMasked}</label>
            <input className="input font-mono tracking-[0.4em] text-center text-[18px]" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoFocus />
            {error && <p className="text-[12.5px] text-rose-600 mt-2">{error}</p>}
            <button className="btn-primary btn-lg w-full mt-4" disabled={busy || otp.length !== 6}>
              {busy ? 'Checking…' : 'Open'}
            </button>
            {!live && <p className="text-[12px] text-slate-400 mt-3 text-center">Demo code: {DEMO_SHARE_OTP}</p>}
          </form>
        ) : (
          <button onClick={() => open(null)} className="btn-primary btn-lg w-full mt-6" disabled={busy}>
            {busy ? 'Opening…' : 'View'}
          </button>
        )}
      </div>
    )
  }

  return shell(
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-[12px] text-slate-400 uppercase tracking-wider font-semibold">{study.patientName}</p>
        <h1 className="text-[18px] font-semibold text-slate-900 mt-0.5">
          {study.modality} {study.bodyPart}
        </h1>
        <p className="text-[13px] text-slate-500">{dateTime(study.studyDate)}</p>
      </div>

      <div className="card p-5">
        <p className="text-[14px] font-semibold text-slate-900 mb-3">Images</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {series.map((s) => (
            <button key={s.id} onClick={() => setViewer(s)} className="rounded-xl border border-slate-200 hover:border-brand-400 px-3 py-3 text-left transition">
              <I.Image size={18} className="text-brand-600" />
              <p className="text-[12.5px] font-medium text-slate-800 mt-1.5 truncate">{s.name}</p>
              <p className="text-[11.5px] text-slate-400">{s.count} images</p>
            </button>
          ))}
        </div>
      </div>

      {study.report ? (
        <div className="card p-5">
          <p className="text-[14px] font-semibold text-slate-900 mb-3">Report</p>
          <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1">Findings</p>
          <p className="text-[14px] text-slate-700 leading-relaxed whitespace-pre-line">{study.report.findings}</p>
          <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mt-4 mb-1">Impression</p>
          <p className="text-[14px] text-slate-800 font-medium leading-relaxed whitespace-pre-line">{study.report.impression}</p>
          <p className="text-[12px] text-slate-400 mt-4">
            Signed by {study.report.signedBy} · {dateTime(study.report.signedAt)}
          </p>
        </div>
      ) : (
        info.includeReport === false && <p className="text-[12.5px] text-slate-400 text-center">The report is not part of this link.</p>
      )}

      {viewer && <SimpleViewer study={study} series={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}
