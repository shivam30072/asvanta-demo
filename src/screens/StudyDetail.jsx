import { useEffect, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { EmptyState, ModalityBadge, PriorityChip, StatusChip } from '../components/ui'
import SeriesThumb from '../viewer/SeriesThumb'
import { buildSeries } from '../viewer/series'
import { RADIOLOGISTS } from '../data/seed'
import SendToMobileModal from '../components/SendToMobileModal'
import { api } from '../live/api'
import { bytes, dateTime, retentionDaysLeft, timeAgo } from '../lib/format'

const KIND_ICON = {
  create: I.UserPlus,
  assign: I.Mail,
  auth: I.Shield,
  upload: I.Upload,
  db: I.Database,
  report: I.Pencil,
  sign: I.CheckCircle,
  share: I.Send,
  view: I.Eye,
  receive: I.Activity,
}

const KIND_TINT = {
  create: 'bg-slate-100 text-slate-500',
  assign: 'bg-sky-50 text-sky-600',
  auth: 'bg-amber-50 text-amber-600',
  upload: 'bg-brand-50 text-brand-600',
  db: 'bg-violet-50 text-violet-600',
  report: 'bg-sky-50 text-sky-600',
  sign: 'bg-emerald-50 text-emerald-600',
  share: 'bg-emerald-50 text-emerald-600',
  view: 'bg-slate-100 text-slate-500',
  receive: 'bg-brand-50 text-brand-600',
}

const TABS = [
  { key: 'images', label: 'Images', icon: I.Image },
  { key: 'report', label: 'Report', icon: I.FileText },
  { key: 'activity', label: 'Activity', icon: I.Activity },
  { key: 'delivery', label: 'Delivery', icon: I.Send },
]

export default function StudyDetail() {
  const { state, navigate, getStudy, live, loadSeries, refreshStudy, updateStudy, toast } = useStore()
  const study = getStudy(state.route.params.id) || state.studies[0]
  const [tab, setTab] = useState('images')
  const [share, setShare] = useState(false) // false | 'images' | 'report'

  // studies from the PACS: fetch the series list the first time the study is opened
  useEffect(() => {
    if (study?.source === 'pacs' && !study.seriesList) loadSeries(study.id).catch((e) => toast('Could not load series', 'error', e.message))
  }, [study?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async (sh) => {
    if (!window.confirm(`Withdraw the link sent to ${sh.to}? It stops working immediately.`)) return
    try {
      await api(`/shares/${sh.id}`, { method: 'DELETE' })
      await refreshStudy(study.id)
      toast('Link withdrawn', 'success')
    } catch (e) {
      toast('Could not withdraw the link', 'error', e.message)
    }
  }

  if (!study) {
    return (
      <Shell title="Study">
        <EmptyState icon={<I.Layers size={24} />} title="Study not found" action={<button onClick={() => navigate('studies')} className="btn-primary btn-md">Back to studies</button>} />
      </Shell>
    )
  }

  const days = retentionDaysLeft(study.createdAt)
  const thumbCount = Math.max(0, study.images)
  const series = thumbCount > 0 ? buildSeries(study) : []

  return (
    <Shell
      wide
      title={study.patient.name}
      subtitle={`${study.id} · ${study.modality} ${study.bodyPart} · ${study.receivedFrom ? `received from ${study.receivedFrom.aeTitle}` : 'registered'} ${timeAgo(study.createdAt)}`}
      actions={
        <>
          <button onClick={() => navigate(state.role === 'radiologist' ? 'worklist' : 'studies')} className="btn-ghost btn-md">
            <I.ArrowLeft size={16} /> <span className="hidden sm:inline">Back</span>
          </button>
          {state.role === 'radiologist' && study.status !== 'ready' && (
            <button onClick={() => navigate('report', { id: study.id })} className="btn-primary btn-md">
              <I.Pencil size={16} /> Report study
            </button>
          )}
          {state.role === 'staff' && (
            <button onClick={() => setShare('images')} className="btn-primary btn-md">
              <I.Phone size={16} /> Send to mobile
            </button>
          )}
        </>
      }
    >
      {/* Signed and waiting on the centre to release it */}
      {study.report && study.status === 'ready' && state.role === 'staff' && (
        <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 mb-5 flex flex-wrap items-center gap-3.5 animate-fade-up">
          <div className="h-11 w-11 rounded-xl bg-emerald-500 text-white grid place-items-center shrink-0">
            <I.CheckCircle size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-emerald-900">
              {study.report.signedBy} signed this report {timeAgo(study.report.signedAt)}
            </p>
            <p className="text-[12.5px] text-emerald-800/80 mt-0.5">
              The report has not been sent to anyone yet. Send it to the patient's (or any) mobile number when you're ready.
            </p>
          </div>
          <button onClick={() => setShare('report')} className="btn-primary btn-md shrink-0">
            <I.Phone size={16} /> Send report
          </button>
        </div>
      )}

      {study.report && study.status === 'ready' && state.role === 'radiologist' && (
        <div className="rounded-2xl bg-slate-100 border border-slate-200 p-4 mb-5 flex items-center gap-3">
          <I.Clock size={17} className="text-slate-500 shrink-0" />
          <p className="text-[13px] text-slate-600">
            Signed {timeAgo(study.report.signedAt)} — with the centre, waiting to be published to the patient.
          </p>
        </div>
      )}

      {/* Header card */}
      <div className="card p-5 mb-5">
        <div className="flex flex-wrap items-start gap-4 sm:gap-5">
          <ModalityBadge modality={study.modality} />
          <div className="min-w-[200px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold text-slate-900">{study.patient.name}</h2>
              <span className="text-[12.5px] text-slate-400 font-mono">{study.patient.id}</span>
              <StatusChip status={study.status} />
              <PriorityChip priority={study.priority} />
            </div>
            <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2.5">
              {[
                ['Examination', `${study.modality} — ${study.bodyPart}`],
                ['Patient', `${study.patient.age}${study.patient.gender} · ${study.patient.phone}`],
                ['Referred by', study.referredBy],
                ['Reporting radiologist', RADIOLOGISTS.find((r) => r.id === study.assignedTo)?.name || 'Not assigned'],
              ].map(([k, v]) => (
                <div key={k}>
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold">{k}</p>
                  <p className="text-[13px] text-slate-700 mt-0.5 truncate">{v}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-100 p-3.5 w-full sm:w-auto sm:min-w-[180px]">
            <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold">Storage</p>
            <p className="text-[15px] font-semibold text-slate-900 mt-1">{bytes(study.sizeBytes)}</p>
            <p className="text-[12px] text-slate-500">{study.images} images · {study.receivedFrom ? 'in PACS' : `${study.files.length} file${study.files.length === 1 ? '' : 's'}`}</p>
            <div className="mt-2.5 pt-2.5 border-t border-slate-200/70">
              <p className="text-[12px] text-slate-500 flex items-center gap-1.5">
                <I.Clock size={12} /> Auto-deletes in {days} days
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-3.5 sm:px-4 h-11 text-[13.5px] font-medium border-b-2 -mb-px transition shrink-0 ${
              tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <t.icon size={16} />
            {t.label}
            {t.key === 'delivery' && study.shares.length > 0 && (
              <span className="chip bg-slate-100 text-slate-500 !text-[10.5px] !px-1.5 !py-0">{study.shares.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Images */}
      {tab === 'images' && (
        <div className="grid lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2">
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[15px] font-semibold text-slate-900">Series</h3>
                  <p className="text-[12.5px] text-slate-500">{study.receivedFrom ? 'Served from the PACS through the gateway — never directly.' : 'Loaded from private storage with a short-lived link.'}</p>
                </div>
                {thumbCount > 0 && (
                  <button onClick={() => navigate('viewer', { id: study.id })} className="btn-primary btn-sm">
                    <I.Eye size={15} /> Open viewer
                  </button>
                )}
              </div>

              {thumbCount === 0 ? (
                <EmptyState
                  icon={<I.Image size={24} />}
                  title="No images uploaded yet"
                  body="This study is registered but nothing has been transferred to storage."
                  action={<button onClick={() => navigate('upload', { id: study.id })} className="btn-primary btn-md"><I.Upload size={16} /> Upload images</button>}
                />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {series.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => navigate('viewer', { id: study.id })}
                      className="group text-left rounded-xl overflow-hidden border border-slate-200 hover:border-brand-400 hover:shadow-pop transition"
                    >
                      <div className="relative aspect-square bg-black">
                        <SeriesThumb series={s} />
                        <div className="absolute inset-0 bg-brand-600/0 group-hover:bg-brand-600/15 transition grid place-items-center">
                          <span className="opacity-0 group-hover:opacity-100 transition rounded-full bg-white/95 text-brand-700 h-9 w-9 grid place-items-center">
                            <I.Eye size={17} />
                          </span>
                        </div>
                        <span className="absolute right-1.5 bottom-1 text-[10px] font-mono text-white/75">{s.count}</span>
                      </div>
                      <div className="px-2.5 py-2">
                        <p className="text-[12.5px] font-medium text-slate-800 truncate">{s.name}</p>
                        <p className="text-[11px] text-slate-400">
                          Series {s.number}{s.thickness > 0 ? ` · ${s.thickness} mm` : ''}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-5">
            <div className="card p-5">
              <h3 className="text-[15px] font-semibold text-slate-900 mb-3.5">{study.receivedFrom ? 'Source' : 'Stored objects'}</h3>
              {study.receivedFrom ? (
                <dl className="text-[13px] space-y-1.5">
                  <div className="flex gap-3"><dt className="text-slate-400 w-20">Scanner</dt><dd className="font-mono text-slate-700">{study.receivedFrom.aeTitle}</dd></div>
                  <div className="flex gap-3"><dt className="text-slate-400 w-20">Address</dt><dd className="font-mono text-slate-700">{study.receivedFrom.ip}</dd></div>
                  <div className="flex gap-3"><dt className="text-slate-400 w-20">Protocol</dt><dd className="text-slate-700">DICOM C-STORE → PACS</dd></div>
                </dl>
              ) : study.files.length === 0 ? (
                <p className="text-[13px] text-slate-400">Nothing stored yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {study.files.map((f, i) => (
                    <div key={i} className="flex items-start gap-2.5 rounded-xl border border-slate-100 p-3">
                      <div className="h-8 w-8 rounded-lg bg-slate-50 text-slate-400 grid place-items-center shrink-0">
                        <I.FileText size={15} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-slate-800 truncate">{f.name}</p>
                        <p className="text-[11.5px] text-slate-400">
                          {bytes(f.size)} · {f.parts} part{f.parts > 1 ? 's' : ''}
                        </p>
                        <p className="text-[11px] text-slate-400 font-mono truncate mt-1">
                          studies/{study.id}/{f.name}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card p-4 bg-brand-50/50 border-brand-100">
              <div className="flex gap-2.5">
                <I.Lock size={16} className="text-brand-600 shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-brand-900/80 leading-relaxed">
                  These objects are private. Every view generates a fresh, expiring link tied to the person requesting it.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Report */}
      {tab === 'report' && (
        <div className="card p-6 max-w-3xl">
          {study.report ? (
            <>
              <div className="flex items-start justify-between pb-5 mb-5 border-b border-slate-100">
                <div>
                  <h3 className="text-[16px] font-semibold text-slate-900">Radiology report</h3>
                  <p className="text-[12.5px] text-slate-500 mt-0.5">
                    Signed by {study.report.signedBy} · {dateTime(study.report.signedAt)}
                  </p>
                </div>
                <span className="chip bg-emerald-50 text-emerald-700">
                  <I.CheckCircle size={13} /> Signed
                </span>
              </div>

              <div className="space-y-5">
                <div>
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">Findings</p>
                  <p className="text-[14px] text-slate-700 leading-relaxed whitespace-pre-line">{study.report.findings}</p>
                </div>
                <div>
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">Impression</p>
                  <p className="text-[14px] text-slate-800 font-medium leading-relaxed whitespace-pre-line">{study.report.impression}</p>
                </div>
              </div>

              <div className="mt-6 pt-5 border-t border-slate-100 flex flex-wrap gap-2.5">
                {state.role === 'staff' && (
                  <button onClick={() => setShare('report')} className={study.status === 'shared' ? 'btn-outline btn-md' : 'btn-primary btn-md'}>
                    <I.Phone size={16} /> {study.status === 'shared' ? 'Send again' : 'Send report to mobile'}
                  </button>
                )}
                <button className="btn-outline btn-md">
                  <I.Download size={16} /> Download PDF
                </button>
                {state.role === 'radiologist' && (
                  <button onClick={() => navigate('report', { id: study.id })} className="btn-ghost btn-md">
                    <I.Pencil size={16} /> Amend report
                  </button>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<I.FileText size={24} />}
              title="No report yet"
              body={study.status === 'uploaded' ? 'This study is waiting in the radiologist worklist.' : 'Upload the images first — reporting begins once they land in storage.'}
              action={
                state.role === 'radiologist' ? (
                  <button onClick={() => navigate('report', { id: study.id })} className="btn-primary btn-md">
                    <I.Pencil size={16} /> Start reporting
                  </button>
                ) : null
              }
            />
          )}
        </div>
      )}

      {/* Activity */}
      {tab === 'activity' && (
        <div className="card p-6 max-w-3xl">
          <h3 className="text-[15px] font-semibold text-slate-900 mb-1">Audit trail</h3>
          <p className="text-[12.5px] text-slate-500 mb-6">Every action against this study, in order.</p>

          <div className="space-y-0">
            {study.timeline.map((e, i) => {
              const Icon = KIND_ICON[e.kind] || I.Activity
              const last = i === study.timeline.length - 1
              return (
                <div key={e.id} className="flex gap-3.5">
                  <div className="flex flex-col items-center">
                    <div className={`h-9 w-9 rounded-xl grid place-items-center shrink-0 ${KIND_TINT[e.kind] || 'bg-slate-100 text-slate-500'}`}>
                      <Icon size={16} />
                    </div>
                    {!last && <div className="w-px flex-1 bg-slate-200 my-1" />}
                  </div>
                  <div className={`min-w-0 flex-1 ${last ? '' : 'pb-6'}`}>
                    <p className="text-[13.5px] text-slate-800 leading-snug">{e.text}</p>
                    <p className="text-[12px] text-slate-400 mt-1">
                      {e.actor} · {dateTime(e.at)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Delivery */}
      {tab === 'delivery' && (
        <div className="card p-6 max-w-3xl">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div>
              <h3 className="text-[15px] font-semibold text-slate-900 mb-1">Sent to mobiles</h3>
              <p className="text-[12.5px] text-slate-500">Every link sent for this study, what it contains, and whether it still works.</p>
            </div>
            {state.role === 'staff' && study.shares.length > 0 && (
              <button onClick={() => setShare('images')} className="btn-outline btn-md shrink-0">
                <I.Phone size={16} /> Send
              </button>
            )}
          </div>

          {study.shares.length === 0 ? (
            <EmptyState
              icon={<I.Send size={24} />}
              title="Nothing sent yet"
              body={
                study.report
                  ? 'Images and the signed report can be sent to any mobile number as a secure, expiring link.'
                  : 'The images can be sent to any mobile number now. The report can be added once the radiologist signs it.'
              }
              action={state.role === 'staff' ? <button onClick={() => setShare(study.report ? 'report' : 'images')} className="btn-primary btn-md"><I.Phone size={16} /> Send to mobile</button> : null}
            />
          ) : (
            <div className="space-y-2.5">
              {study.shares.map((s, i) => {
                const meta = {
                  whatsapp: { label: 'WhatsApp · Utility', icon: I.Whatsapp, tint: 'bg-emerald-50 text-emerald-600' },
                  sms: { label: 'SMS · Transactional', icon: I.Phone, tint: 'bg-sky-50 text-sky-600' },
                  email: { label: 'Email · Transactional', icon: I.Mail, tint: 'bg-violet-50 text-violet-600' },
                }[s.channel]
                return (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
                    <div className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${meta.tint}`}>
                      <meta.icon size={17} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-slate-800">
                        {meta.label}
                        {s.includeReport != null && <span className="ml-2 text-[12px] font-normal text-slate-500">{s.includeReport ? 'Images + report' : 'Images only'}</span>}
                      </p>
                      <p className="text-[12.5px] text-slate-500 truncate">
                        <span className="font-mono">{s.to}</span> · {timeAgo(s.at)}
                        {s.expiresAt && ` · ${new Date(s.expiresAt) < new Date() ? 'expired' : `valid until ${dateTime(s.expiresAt)}`}`}
                      </p>
                    </div>
                    {s.revoked ? (
                      <span className="chip bg-slate-100 text-slate-500">withdrawn</span>
                    ) : (
                      <span className={`chip ${s.status === 'read' || s.status === 'opened' ? 'bg-brand-50 text-brand-700' : 'bg-emerald-50 text-emerald-700'}`}>
                        <I.Check size={12} /> {s.status}
                      </span>
                    )}
                    {state.role === 'staff' && !s.revoked && s.id && (
                      <button
                        onClick={() =>
                          live
                            ? revoke(s)
                            : window.confirm(`Withdraw the link sent to ${s.to}?`) &&
                              updateStudy(study.id, (x) => ({ ...x, shares: x.shares.map((y) => (y.id === s.id ? { ...y, revoked: true } : y)) }))
                        }
                        className="text-slate-300 hover:text-rose-500"
                        title="Withdraw link"
                      >
                        <I.X size={16} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <SendToMobileModal open={Boolean(share)} onClose={() => setShare(false)} study={study} defaultIncludeReport={share === 'report'} />

    </Shell>
  )
}
