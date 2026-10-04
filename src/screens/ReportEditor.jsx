import { useEffect, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import { REPORT_TEMPLATES } from '../data/seed'
import * as I from '../components/Icons'
import { EmptyState, Modal, ModalityBadge } from '../components/ui'
import SeriesThumb from '../viewer/SeriesThumb'
import { buildSeries, isCardiac } from '../viewer/series'
import { reportText } from '../cac/review'
import { api } from '../live/api'
import { bytes, dateTime } from '../lib/format'

export default function ReportEditor() {
  const { state, navigate, getStudy, updateStudy, pushEvent, notify, toast, live, user, loadSeries, refreshStudy } = useStore()
  const study = getStudy(state.route.params.id) || state.studies.find((s) => s.status === 'uploaded' || s.status === 'reporting')

  const [findings, setFindings] = useState('')
  const [impression, setImpression] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [signing, setSigning] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  useEffect(() => {
    if (!study) return
    if (study.source === 'pacs' && !study.seriesList) loadSeries(study.id).catch(() => {})
    setFindings(study.report?.findings || study.draft?.findings || '')
    setImpression(study.report?.impression || study.draft?.impression || '')
    if (study.status === 'uploaded') {
      updateStudy(study.id, (s) => ({ ...s, status: 'reporting' }))
      pushEvent(study.id, 'Study opened for reporting', 'report', 'Dr. Anil Mehta')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.id])

  if (!study) {
    return (
      <Shell title="Report">
        <EmptyState icon={<I.FileText size={24} />} title="Nothing to report" body="No study is waiting in the queue." action={<button onClick={() => navigate('worklist')} className="btn-primary btn-md">Back to worklist</button>} />
      </Shell>
    )
  }

  const templates = REPORT_TEMPLATES.filter((t) => !t.modality || t.modality === study.modality)
  const dirty = findings.trim() || impression.trim()

  const applyTemplate = (t) => {
    setFindings(t.findings)
    setImpression(t.impression)
    toast(`Template applied: ${t.label}`, 'info', 'Edit the text before signing.')
  }

  const saveDraft = async () => {
    if (live) {
      try {
        await api(`/studies/${study.id}/report`, { method: 'PUT', body: { findings, impression } })
      } catch (e) {
        return toast('Could not save the draft', 'error', e.message)
      }
    }
    updateStudy(study.id, (s) => ({ ...s, draft: { findings, impression } }))
    setSavedAt(new Date().toISOString())
    toast('Draft saved', 'success', 'Only you can see this until it is signed.')
  }

  const sign = async () => {
    setSigning(true)
    if (live) {
      try {
        await api(`/studies/${study.id}/report`, { method: 'PUT', body: { findings: findings.trim(), impression: impression.trim() } })
        await api(`/studies/${study.id}/report/sign`, { method: 'POST' })
        await refreshStudy(study.id)
        toast('Report signed', 'success', 'The centre can now send it to any mobile number.')
        navigate('worklist')
      } catch (e) {
        toast('Could not sign the report', 'error', e.message)
      } finally {
        setSigning(false)
        setConfirm(false)
      }
      return
    }
    setTimeout(() => {
      const at = new Date().toISOString()
      updateStudy(study.id, (s) => ({
        ...s,
        status: 'ready',
        report: { findings: findings.trim(), impression: impression.trim(), signedBy: user.name, signedAt: at },
      }))
      pushEvent(study.id, 'Report signed — released to the centre for publishing', 'sign', 'Dr. Anil Mehta')
      // the radiologist hands off here; the centre decides when the patient sees it
      notify({
        title: 'Report signed — ready to publish',
        body: `Dr. Mehta signed ${study.id} — ${study.patient.name}. Publish it to the patient.`,
        kind: 'sign',
      })
      setSigning(false)
      setConfirm(false)
      toast('Report signed', 'success', `${study.patient.name}'s report has gone to the centre for release.`)
      navigate('worklist')
    }, 900)
  }

  const series = study.images > 0 ? buildSeries(study) : []
  const cac = study.cac?.review
  const cacApproved = cac?.status === 'approved' ? cac.approved : null

  // only an approved score can reach the report — never the algorithm's number
  const insertCac = () => {
    const text = reportText(cacApproved)
    const placeholder = '[Insert the approved CAC result.]'
    setFindings((f) => (f.includes(placeholder) ? f.replace(placeholder, text) : `${f.trim()}${f.trim() ? '\n\n' : ''}${text}`))
    const score = Math.round(cacApproved.totals.total)
    setImpression((i) => i.replace('Coronary artery calcium score ___ (CAC-DRS ___).', `Coronary artery calcium score ${score} (${cacApproved.category.code}, ${cacApproved.category.label.toLowerCase()}).`))
    toast('Approved CAC result inserted', 'success', `Score ${score} — approved by ${cacApproved.approvedBy}.`)
  }

  return (
    <Shell
      wide
      title={`Reporting — ${study.patient.name}`}
      subtitle={`${study.id} · ${study.modality} ${study.bodyPart} · ${bytes(study.sizeBytes)} · ${study.images} images`}
      actions={
        <>
          <button onClick={() => navigate('worklist')} className="btn-ghost btn-md">
            <I.ArrowLeft size={16} /> <span className="hidden sm:inline">Worklist</span>
          </button>
          <button onClick={saveDraft} className="btn-outline btn-md" disabled={!dirty}>
            Save draft
          </button>
          <button onClick={() => setConfirm(true)} className="btn-primary btn-md" disabled={!findings.trim() || !impression.trim()}>
            <I.CheckCircle size={16} /> Sign &amp; publish
          </button>
        </>
      }
    >
      <div className="grid lg:grid-cols-[300px_minmax(0,1fr)] gap-5">
        {/* Left: images + patient */}
        <div className="space-y-5">
          <div className="card p-4">
            <div className="flex items-center gap-3 mb-3.5">
              <ModalityBadge modality={study.modality} size="sm" />
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-slate-800 truncate">{study.patient.name}</p>
                <p className="text-[12px] text-slate-500">
                  {study.patient.age}
                  {study.patient.gender} · {study.patient.id}
                </p>
              </div>
            </div>
            <dl className="space-y-2 text-[12.5px]">
              {[
                ['Study', study.id],
                ['Protocol', `${study.modality} ${study.bodyPart}`],
                ['Referred by', study.referredBy],
                ['Priority', study.priority],
                ['History', study.notes || '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="text-slate-400 w-20 shrink-0">{k}</dt>
                  <dd className="text-slate-700 min-w-0">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {series.length > 0 && (
            <div className="card p-4">
              <p className="text-[13px] font-semibold text-slate-900 mb-3">Series</p>
              <div className="grid grid-cols-2 gap-2">
                {series.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => navigate('viewer', { id: study.id })}
                    className="rounded-lg overflow-hidden border border-slate-200 hover:border-brand-400 transition text-left"
                  >
                    <div className="relative aspect-square bg-black">
                      <SeriesThumb series={s} />
                      <span className="absolute right-1 bottom-0.5 text-[9.5px] font-mono text-white/75">{s.count}</span>
                    </div>
                    <p className="text-[11px] text-slate-600 px-1.5 py-1 truncate">{s.name}</p>
                  </button>
                ))}
              </div>
              <button onClick={() => navigate('viewer', { id: study.id })} className="btn-primary btn-sm w-full mt-3">
                <I.Eye size={14} /> Open diagnostic viewer
              </button>
            </div>
          )}

          {(cac || isCardiac(study)) && (
            <div className={`card p-4 ${cacApproved ? 'border-emerald-200' : cac ? 'border-amber-200' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[13px] font-semibold text-slate-900">Coronary calcium (CAC)</p>
                <span className={`chip ${cacApproved ? 'bg-emerald-50 text-emerald-700' : cac ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                  {cacApproved ? 'Approved' : cac ? 'Awaiting approval' : 'Not analysed'}
                </span>
              </div>
              {cacApproved ? (
                <>
                  <p className="text-[28px] font-semibold text-slate-900 leading-none">{Math.round(cacApproved.totals.total)}</p>
                  <p className="text-[12px] text-slate-500 mt-1">
                    {cacApproved.category.code} · {cacApproved.category.label}
                    {cacApproved.kind === 'opportunistic' ? ' · opportunistic estimate' : ''}
                  </p>
                  <p className="text-[12px] text-slate-600 mt-2 font-mono">
                    LM {Math.round(cacApproved.totals.LM)} · LAD {Math.round(cacApproved.totals.LAD)} · LCX {Math.round(cacApproved.totals.LCX)} · RCA {Math.round(cacApproved.totals.RCA)}
                  </p>
                  <p className="text-[11.5px] text-slate-400 mt-2">
                    Approved by {cacApproved.approvedBy} · {dateTime(cacApproved.approvedAt)} · algorithm {Math.round(cacApproved.algorithmTotal)} · {cacApproved.engineVersion}
                  </p>
                  <button onClick={insertCac} className="btn-primary btn-sm w-full mt-3">
                    Insert into report
                  </button>
                </>
              ) : (
                <>
                  <p className="text-[12.5px] text-slate-600 leading-relaxed">
                    {cac
                      ? 'An algorithm result exists but has not been reviewed. Unverified scores are never available to the report.'
                      : 'Run the CAC analysis in the viewer, review the lesions and approve the score to use it here.'}
                  </p>
                  <button onClick={() => navigate('viewer', { id: study.id, mode: 'cac' })} className="btn-outline btn-sm w-full mt-3">
                    <I.Activity size={14} /> {cac ? 'Open CAC review' : 'Open CAC analysis'}
                  </button>
                </>
              )}
              {study.cpr && Object.keys(study.cpr).length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <p className="text-[11.5px] font-medium text-slate-500 mb-1">Verified CPR centerlines</p>
                  {Object.entries(study.cpr).map(([v, c]) => (
                    <p key={v} className="text-[12px] text-slate-600">
                      {v}{c.stenosis != null ? ` — est. stenosis ${c.stenosis}%` : ''} <span className="text-slate-400">· {c.by}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="card p-4">
            <p className="text-[13px] font-semibold text-slate-900 mb-2.5">Templates</p>
            <div className="space-y-1.5">
              {templates.length === 0 && <p className="text-[12.5px] text-slate-400">No template for this modality.</p>}
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t)}
                  className="w-full text-left rounded-xl border border-slate-200 px-3 py-2.5 hover:border-brand-300 hover:bg-brand-50/50 transition group"
                >
                  <p className="text-[12.5px] font-medium text-slate-700 group-hover:text-brand-700">{t.label}</p>
                  <p className="text-[11.5px] text-slate-400 truncate">{t.impression}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: editor */}
        <div className="space-y-5">
          <div className="card p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-900">Report</h2>
                <p className="text-[12.5px] text-slate-500">
                  {study.report ? `Previously signed ${dateTime(study.report.signedAt)} — amending creates a new version.` : 'Unsigned draft — visible only to you until signed.'}
                </p>
              </div>
              {savedAt && (
                <span className="chip bg-slate-100 text-slate-500">
                  <I.Check size={12} /> Draft saved
                </span>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="label !mb-0">Findings</label>
                  <span className="text-[11.5px] text-slate-400">{findings.length} characters</span>
                </div>
                <textarea
                  value={findings}
                  onChange={(e) => setFindings(e.target.value)}
                  rows={12}
                  placeholder="Describe the imaging findings…"
                  className="input !h-auto py-3 leading-relaxed resize-y text-[13.5px]"
                />
              </div>

              <div>
                <label className="label">Impression</label>
                <textarea
                  value={impression}
                  onChange={(e) => setImpression(e.target.value)}
                  rows={4}
                  placeholder="Summarise the conclusion and any recommendation…"
                  className="input !h-auto py-3 leading-relaxed resize-y text-[13.5px] !border-brand-200 bg-brand-50/30"
                />
              </div>
            </div>

            <div className="mt-6 pt-5 border-t border-slate-100 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2.5 flex-1 min-w-[200px]">
                <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white text-[11px] font-semibold grid place-items-center">AM</div>
                <div>
                  <p className="text-[13px] font-medium text-slate-800">Dr. Anil Mehta</p>
                  <p className="text-[11.5px] text-slate-500">Consultant Radiologist, MD · Reg. MMC-48211</p>
                </div>
              </div>
              <button onClick={saveDraft} className="btn-outline btn-md" disabled={!dirty}>
                Save draft
              </button>
              <button onClick={() => setConfirm(true)} className="btn-primary btn-md" disabled={!findings.trim() || !impression.trim()}>
                <I.CheckCircle size={16} /> Sign &amp; publish
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sign confirmation */}
      <Modal
        open={confirm}
        onClose={() => !signing && setConfirm(false)}
        title="Sign and publish this report?"
        subtitle={`${study.patient.name} · ${study.id}`}
        icon={<I.Shield size={19} />}
      >
        <div className="p-6">
          <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
            <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">Impression</p>
            <p className="text-[13.5px] text-slate-700 leading-relaxed">{impression || '—'}</p>
          </div>

          <ul className="mt-4 space-y-2.5">
            {[
              'Your digital signature is attached and the report becomes read-only.',
              'The centre is notified and decides when to publish it to the patient.',
              'Nothing is sent to the patient by this action.',
              'Any later change is recorded as an amendment, not an edit.',
              ...(cac && !cacApproved ? ['The CAC analysis is not approved — no calcium score is included.'] : []),
            ].map((t) => (
              <li key={t} className="flex gap-2.5 text-[13px] text-slate-600">
                <I.Check size={15} className="text-emerald-600 shrink-0 mt-0.5" />
                {t}
              </li>
            ))}
          </ul>

          <div className="mt-6 flex gap-2.5">
            <button onClick={() => setConfirm(false)} className="btn-ghost btn-lg flex-1" disabled={signing}>
              Back to editing
            </button>
            <button onClick={sign} className="btn-primary btn-lg flex-1" disabled={signing}>
              {signing ? 'Signing…' : 'Sign report'}
            </button>
          </div>
        </div>
      </Modal>

    </Shell>
  )
}
