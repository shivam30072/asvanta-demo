import { useMemo, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { EmptyState, ModalityBadge } from '../components/ui'
import { dateTime, timeAgo } from '../lib/format'

const META = {
  whatsapp: { label: 'WhatsApp', sub: 'Utility template', icon: I.Whatsapp, tint: 'bg-emerald-50 text-emerald-600' },
  sms: { label: 'SMS', sub: 'Transactional route', icon: I.Phone, tint: 'bg-sky-50 text-sky-600' },
  email: { label: 'Email', sub: 'Transactional', icon: I.Mail, tint: 'bg-violet-50 text-violet-600' },
}

export default function Deliveries() {
  const { state, navigate } = useStore()
  const [channel, setChannel] = useState('all')

  const rows = useMemo(() => {
    const out = []
    state.studies.forEach((s) => s.shares.forEach((sh) => out.push({ ...sh, study: s })))
    return out
      .filter((r) => channel === 'all' || r.channel === channel)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
  }, [state.studies, channel])

  const counts = useMemo(() => {
    const all = state.studies.flatMap((s) => s.shares)
    return {
      all: all.length,
      whatsapp: all.filter((s) => s.channel === 'whatsapp').length,
      sms: all.filter((s) => s.channel === 'sms').length,
      email: all.filter((s) => s.channel === 'email').length,
      opened: all.filter((s) => s.status === 'read' || s.status === 'opened').length,
    }
  }, [state.studies])

  return (
    <Shell
      title="Deliveries"
      subtitle={`${counts.all} report links sent · ${counts.opened} opened by patients`}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        {[
          { icon: I.Send, label: 'Links sent', value: counts.all, tint: 'bg-brand-50 text-brand-600' },
          { icon: I.Whatsapp, label: 'WhatsApp', value: counts.whatsapp, tint: 'bg-emerald-50 text-emerald-600' },
          { icon: I.Phone, label: 'SMS', value: counts.sms, tint: 'bg-sky-50 text-sky-600' },
          { icon: I.Mail, label: 'Email', value: counts.email, tint: 'bg-violet-50 text-violet-600' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className={`h-10 w-10 rounded-xl grid place-items-center ${s.tint}`}>
              <s.icon size={19} />
            </div>
            <p className="text-[24px] font-semibold text-slate-900 mt-4 leading-none">{s.value}</p>
            <p className="text-[12.5px] text-slate-500 mt-2">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="card p-3 mb-5 flex items-center gap-1 w-fit">
        {['all', 'whatsapp', 'sms', 'email'].map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={`h-9 px-4 rounded-xl text-[13px] font-medium capitalize transition ${
              channel === c ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<I.Send size={24} />} title="No deliveries yet" body="Report links you send to patients will be logged here." />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((r, i) => {
              const m = META[r.channel]
              return (
                <div key={i} className="px-5 py-3.5 flex items-center gap-3.5 hover:bg-slate-50/70 transition">
                  <div className={`h-10 w-10 rounded-xl grid place-items-center shrink-0 ${m.tint}`}>
                    <m.icon size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[13.5px] font-medium text-slate-800 truncate">{r.study.patient.name}</p>
                      <span className="text-[11.5px] text-slate-400 font-mono">{r.study.id}</span>
                    </div>
                    <p className="text-[12.5px] text-slate-500 truncate">
                      {m.label} · {m.sub} → {r.to}
                    </p>
                  </div>
                  <div className="hidden md:block shrink-0">
                    <ModalityBadge modality={r.study.modality} size="sm" />
                  </div>
                  <div className="text-right shrink-0 w-28 hidden sm:block">
                    <p className="text-[12.5px] text-slate-600">{timeAgo(r.at)}</p>
                    <p className="text-[11px] text-slate-400">{dateTime(r.at).split(', ')[1]}</p>
                  </div>
                  <span className={`chip shrink-0 ${r.status === 'read' || r.status === 'opened' ? 'bg-brand-50 text-brand-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    <I.Check size={12} /> {r.status}
                  </span>
                  <button onClick={() => navigate('study', { id: r.study.id })} className="btn-ghost h-8 w-8 rounded-lg shrink-0">
                    <I.ChevronRight size={16} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="card p-4 mt-5 bg-slate-50/70">
        <div className="flex gap-2.5">
          <I.Shield size={16} className="text-slate-400 shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-slate-500 leading-relaxed">
            Messages carry a link only — no images or reports are attached. Each link expires on the schedule chosen when it was sent, and can require an OTP before it opens.
          </p>
        </div>
      </div>
    </Shell>
  )
}
