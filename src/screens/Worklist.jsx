import { useMemo, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { Avatar, EmptyState, ModalityBadge, PriorityChip, StatusChip } from '../components/ui'
import { RADIOLOGISTS } from '../data/seed'
import { bytes, timeAgo } from '../lib/format'

const DEMO_ME = 'rad_mehta' // the demo's radiologist; live mode uses the signed-in user's id
const unread = (s) => s.status === 'uploaded' || s.status === 'reporting'

const QUEUES = [
  { key: 'mine', label: 'Assigned to me', match: (s, me) => unread(s) && s.assignedTo === me },
  { key: 'pending', label: 'All unreported', match: unread },
  { key: 'signed', label: 'Signed by me', match: (s) => s.status === 'ready' || s.status === 'shared' },
  { key: 'all', label: 'All studies', match: () => true },
]

export default function Worklist() {
  const { state, navigate, user } = useStore()
  const ME = user?.radiologistId || DEMO_ME
  const [queue, setQueue] = useState('mine')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const match = QUEUES.find((x) => x.key === queue).match
    return state.studies
      .filter((s) => match(s, ME))
      .filter((s) => (q ? `${s.patient.name} ${s.id} ${s.modality} ${s.bodyPart}`.toLowerCase().includes(q.toLowerCase()) : true))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === 'Urgent' ? -1 : 1
        return new Date(a.createdAt) - new Date(b.createdAt)
      })
  }, [state.studies, queue, q, ME])

  const counts = useMemo(
    () => ({
      mine: state.studies.filter((s) => QUEUES[0].match(s, ME)).length,
      urgent: state.studies.filter((s) => QUEUES[0].match(s, ME) && s.priority === 'Urgent').length,
      signed: state.studies.filter((s) => QUEUES[2].match(s, ME)).length,
    }),
    [state.studies, ME]
  )

  return (
    <Shell
      wide
      title="Reporting worklist"
      subtitle={`${counts.mine} studies assigned to you · ${counts.urgent} marked urgent`}
    >
      <div className="grid sm:grid-cols-3 gap-4 mb-5">
        {[
          { icon: I.Clock, label: 'Assigned to you', value: counts.mine, tone: 'bg-amber-50 text-amber-600' },
          { icon: I.Zap, label: 'Urgent in queue', value: counts.urgent, tone: 'bg-rose-50 text-rose-600' },
          { icon: I.CheckCircle, label: 'Signed by me', value: counts.signed, tone: 'bg-emerald-50 text-emerald-600' },
        ].map((s) => (
          <div key={s.label} className="card p-5 flex items-center gap-4">
            <div className={`h-11 w-11 rounded-xl grid place-items-center ${s.tone}`}>
              <s.icon size={20} />
            </div>
            <div>
              <p className="text-[24px] font-semibold text-slate-900 leading-none">{s.value}</p>
              <p className="text-[12.5px] text-slate-500 mt-1.5">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-3 mb-5 flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          {QUEUES.map((x) => (
            <button
              key={x.key}
              onClick={() => setQueue(x.key)}
              className={`h-8 px-3.5 rounded-lg text-[12.5px] font-medium transition ${
                queue === x.key ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <I.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the worklist…" className="input !pl-10" />
        </div>
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<I.CheckCircle size={24} />} title="Queue is clear" body="Nothing is waiting to be reported right now." />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((s) => (
              <div key={s.id} className="px-5 py-4 flex flex-wrap items-center gap-4 hover:bg-slate-50/70 transition">
                <ModalityBadge modality={s.modality} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-medium text-slate-800 truncate">{s.patient.name}</p>
                    <span className="text-[12px] text-slate-400 font-mono">{s.id}</span>
                    <PriorityChip priority={s.priority} />
                    <StatusChip status={s.status} size="sm" />
                  </div>
                  <p className="text-[12.5px] text-slate-500 mt-0.5 truncate">
                    {s.modality} — {s.bodyPart} · {s.patient.age}
                    {s.patient.gender} · {bytes(s.sizeBytes)} · {s.images} images · ref. {s.referredBy}
                  </p>
                  {(() => {
                    const doc = RADIOLOGISTS.find((r) => r.id === s.assignedTo)
                    if (!doc) return <p className="text-[11.5px] text-amber-600 mt-1">Not assigned to a radiologist</p>
                    return (
                      <p className={`text-[11.5px] mt-1 flex items-center gap-1.5 ${doc.id === ME ? 'text-brand-600' : 'text-slate-400'}`}>
                        <I.Stethoscope size={12} />
                        {doc.id === ME ? 'Assigned to you' : `Assigned to ${doc.name}`}
                      </p>
                    )
                  })()}
                </div>
                <div className="text-right hidden md:block">
                  <p className="text-[12.5px] text-slate-500">Waiting</p>
                  <p className="text-[13px] font-medium text-slate-700">{timeAgo(s.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => navigate('study', { id: s.id })} className="btn-outline btn-sm">
                    <I.Eye size={15} /> Open
                  </button>
                  <button onClick={() => navigate('report', { id: s.id })} className="btn-primary btn-sm">
                    {s.report ? <><I.Pencil size={15} /> Amend</> : <><I.Pencil size={15} /> Report</>}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  )
}
