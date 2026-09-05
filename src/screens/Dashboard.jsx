import { useMemo, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { ModalityBadge, PriorityChip, SectionTitle, StatusChip } from '../components/ui'
import ShareModal from '../components/ShareModal'
import { bytes, timeAgo } from '../lib/format'

const Stat = ({ icon: Icon, label, value, sub, tone = 'brand', trend }) => {
  const tones = {
    brand: 'bg-brand-50 text-brand-600',
    violet: 'bg-violet-50 text-violet-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
  }
  return (
    <div className="card p-5 hover:shadow-pop hover:-translate-y-0.5 transition-all duration-200">
      <div className="flex items-start justify-between">
        <div className={`h-10 w-10 rounded-xl grid place-items-center ${tones[tone]}`}>
          <Icon size={19} />
        </div>
        {trend && (
          <span className="chip bg-emerald-50 text-emerald-600 !text-[11px]">
            <I.Activity size={11} /> {trend}
          </span>
        )}
      </div>
      <p className="text-[26px] font-semibold text-slate-900 tracking-tight mt-4 leading-none">{value}</p>
      <p className="text-[13px] font-medium text-slate-600 mt-2">{label}</p>
      {sub && <p className="text-[12px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

const FlowStep = ({ n, icon: Icon, title, body, done }) => (
  <div className="relative flex gap-3.5">
    <div className="flex flex-col items-center">
      <div className={`h-9 w-9 rounded-xl grid place-items-center shrink-0 ${done ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
        <Icon size={17} />
      </div>
      {n < 5 && <div className="w-px flex-1 bg-slate-150 bg-slate-200 my-1" />}
    </div>
    <div className="pb-5 min-w-0">
      <p className="text-[13.5px] font-medium text-slate-800">{title}</p>
      <p className="text-[12.5px] text-slate-500 leading-relaxed mt-0.5">{body}</p>
    </div>
  </div>
)

export default function Dashboard() {
  const { state, navigate } = useStore()
  const [publishing, setPublishing] = useState(null)
  const studies = state.studies

  const stats = useMemo(() => {
    const today = studies.filter((s) => Date.now() - new Date(s.createdAt).getTime() < 86400000)
    const pending = studies.filter((s) => s.status === 'uploaded' || s.status === 'reporting')
    const toPublish = studies.filter((s) => s.status === 'ready')
    const shared = studies.filter((s) => s.status === 'shared')
    const storage = studies.reduce((a, s) => a + s.sizeBytes, 0)
    return { today: today.length, pending: pending.length, toPublish, shared: shared.length, storage }
  }, [studies])

  const recent = studies.slice(0, 5)

  return (
    <Shell
      title={`Good morning, Priya`}
      subtitle={`${state.centre.name}`}
      actions={
        <button onClick={() => navigate('new-study')} className="btn-primary btn-md">
          <I.UserPlus size={16} /> <span className="hidden sm:inline">New study</span>
        </button>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={I.Layers} label="Studies today" value={stats.today} sub="Registered at this centre" tone="brand" trend="+12%" />
        <Stat icon={I.Clock} label="Awaiting report" value={stats.pending} sub="In the radiologist queue" tone="amber" />
        <Stat icon={I.CheckCircle} label="Ready to publish" value={stats.toPublish.length} sub="Signed, not yet sent to patients" tone="emerald" />
        <Stat icon={I.Send} label="Sent to patients" value={stats.shared} sub={`${bytes(stats.storage)} of imaging stored`} tone="violet" />
      </div>

      {/* Signed reports the centre still has to release */}
      {stats.toPublish.length > 0 && (
        <div className="card mt-6 overflow-hidden border-emerald-200">
          <div className="px-5 py-3.5 bg-emerald-50/70 border-b border-emerald-100 flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-emerald-500 text-white grid place-items-center shrink-0">
              <I.CheckCircle size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-[14.5px] font-semibold text-emerald-900">
                {stats.toPublish.length} signed report{stats.toPublish.length > 1 ? 's' : ''} waiting to be published
              </h2>
              <p className="text-[12.5px] text-emerald-800/75">The radiologist is done. These patients have not been told yet.</p>
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {stats.toPublish.map((s) => (
              <div key={s.id} className="px-4 py-3.5 flex flex-wrap items-center gap-3.5 hover:bg-slate-50/70 transition">
                <ModalityBadge modality={s.modality} size="sm" />
                <button onClick={() => navigate('study', { id: s.id })} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <p className="text-[13.5px] font-medium text-slate-800 truncate">{s.patient.name}</p>
                    <span className="text-[11.5px] text-slate-400 font-mono">{s.id}</span>
                  </div>
                  <p className="text-[12.5px] text-slate-500 truncate">
                    {s.modality} · {s.bodyPart} · signed by {s.report.signedBy} {timeAgo(s.report.signedAt)}
                  </p>
                </button>
                <button onClick={() => setPublishing(s)} className="btn-primary btn-sm shrink-0">
                  <I.Share size={15} /> Publish
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-5 mt-6">
        {/* Recent studies */}
        <div className="lg:col-span-2">
          <SectionTitle
            action={
              <button onClick={() => navigate('studies')} className="text-[13px] font-medium text-brand-600 hover:underline flex items-center gap-1">
                View all <I.ChevronRight size={14} />
              </button>
            }
          >
            Recent studies
          </SectionTitle>

          <div className="card divide-y divide-slate-100 overflow-hidden">
            {recent.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate('study', { id: s.id })}
                className="w-full flex items-center gap-3.5 px-4 py-3.5 hover:bg-slate-50/80 transition text-left group"
              >
                <ModalityBadge modality={s.modality} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[13.5px] font-medium text-slate-800 truncate">{s.patient.name}</p>
                    <span className="text-[11.5px] text-slate-400 font-mono shrink-0">{s.id}</span>
                  </div>
                  <p className="text-[12.5px] text-slate-500 truncate">
                    {s.modality} · {s.bodyPart} · {bytes(s.sizeBytes)}
                  </p>
                </div>
                <div className="hidden sm:block shrink-0">
                  <StatusChip status={s.status} size="sm" />
                </div>
                <span className="text-[12px] text-slate-400 shrink-0 w-20 text-right hidden md:block">{timeAgo(s.createdAt)}</span>
                <I.ChevronRight size={16} className="text-slate-300 group-hover:text-brand-500 group-hover:translate-x-0.5 transition shrink-0" />
              </button>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          <div>
            <SectionTitle>Quick actions</SectionTitle>
            <div className="card p-2 space-y-1">
              {[
                { icon: I.UserPlus, label: 'Register a new patient study', to: 'new-study' },
                { icon: I.Upload, label: 'Upload images to a study', to: 'upload' },
                { icon: I.Layers, label: 'Browse previous uploads', to: 'studies' },
                { icon: I.Send, label: 'Check what patients received', to: 'deliveries' },
              ].map((a) => (
                <button
                  key={a.to}
                  onClick={() => navigate(a.to)}
                  className="w-full flex items-center gap-3 rounded-xl px-3 h-11 text-[13.5px] font-medium text-slate-700 hover:bg-brand-50 hover:text-brand-700 transition group"
                >
                  <a.icon size={17} className="text-slate-400 group-hover:text-brand-600" />
                  <span className="text-left">{a.label}</span>
                  <I.ChevronRight size={15} className="ml-auto text-slate-300 group-hover:text-brand-500" />
                </button>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle>How a study travels</SectionTitle>
            <div className="card p-5">
              <FlowStep n={1} icon={I.UserPlus} title="Register" body="Patient and study details are saved; a study ID is issued." done />
              <FlowStep n={2} icon={I.Upload} title="Upload" body="Images go straight from this browser into private storage." done />
              <FlowStep n={3} icon={I.Stethoscope} title="Report &amp; sign" body="The radiologist reads the study and signs. Nothing reaches the patient yet." done />
              <FlowStep n={4} icon={I.Send} title="Publish" body="The centre reviews the signed report and releases it by WhatsApp, SMS and email." done />
              <FlowStep n={5} icon={I.Clock} title="Expire" body="Images are deleted automatically 365 days after upload." done />
            </div>
          </div>
        </div>
      </div>
      {publishing && <ShareModal open onClose={() => setPublishing(null)} study={state.studies.find((x) => x.id === publishing.id) || publishing} />}
    </Shell>
  )
}
