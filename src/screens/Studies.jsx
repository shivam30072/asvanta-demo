import { useMemo, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { EmptyState, ModalityBadge, PriorityChip, StatusChip } from '../components/ui'
import { bytes, dateTime, retentionDaysLeft, timeAgo } from '../lib/format'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'uploading', label: 'Uploading' },
  { key: 'uploaded', label: 'Awaiting report' },
  { key: 'reporting', label: 'Reporting' },
  { key: 'ready', label: 'To publish' },
  { key: 'shared', label: 'Sent' },
]

export default function Studies() {
  const { state, navigate } = useStore()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [modality, setModality] = useState('all')
  const [sort, setSort] = useState('recent')

  const rows = useMemo(() => {
    let list = state.studies.filter((s) => {
      if (filter !== 'all' && s.status !== filter) return false
      if (modality !== 'all' && s.modality !== modality) return false
      if (!q.trim()) return true
      const t = q.toLowerCase()
      return (
        s.patient.name.toLowerCase().includes(t) ||
        s.id.toLowerCase().includes(t) ||
        s.patient.id.toLowerCase().includes(t) ||
        s.bodyPart.toLowerCase().includes(t) ||
        s.modality.toLowerCase().includes(t)
      )
    })
    list = [...list].sort((a, b) =>
      sort === 'recent'
        ? new Date(b.createdAt) - new Date(a.createdAt)
        : sort === 'size'
        ? b.sizeBytes - a.sizeBytes
        : a.patient.name.localeCompare(b.patient.name)
    )
    return list
  }, [state.studies, q, filter, modality, sort])

  const modalities = useMemo(() => ['all', ...new Set(state.studies.map((s) => s.modality))], [state.studies])
  const totalSize = state.studies.reduce((a, s) => a + s.sizeBytes, 0)

  return (
    <Shell
      wide
      title="Studies"
      subtitle={`${state.studies.length} studies · ${bytes(totalSize)} of imaging stored at this centre`}
      actions={
        <button onClick={() => navigate('scanners')} className="btn-outline btn-md">
          <I.Activity size={16} /> <span className="hidden sm:inline">Scanners</span>
        </button>
      }
    >
      {/* Toolbar */}
      <div className="card p-3 mb-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <I.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search patient, study ID, modality…"
              className="input !pl-10"
            />
          </div>

          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`h-8 px-3 rounded-lg text-[12.5px] font-medium transition ${
                  filter === f.key ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <select value={modality} onChange={(e) => setModality(e.target.value)} className="input !w-auto !h-10 text-[13px]">
            {modalities.map((m) => (
              <option key={m} value={m}>
                {m === 'all' ? 'All modalities' : m}
              </option>
            ))}
          </select>

          <select value={sort} onChange={(e) => setSort(e.target.value)} className="input !w-auto !h-10 text-[13px]">
            <option value="recent">Most recent</option>
            <option value="size">Largest first</option>
            <option value="name">Patient A–Z</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="hidden lg:grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_140px_130px_160px_40px] gap-4 px-5 py-3 border-b border-slate-100 bg-slate-50/60 text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">
          <span>Patient / Study</span>
          <span>Examination</span>
          <span>Uploaded</span>
          <span>Status</span>
          <span>Retention</span>
          <span />
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={<I.Search size={24} />} title="No studies match" body="Try a different search term or clear the filters." action={<button onClick={() => { setQ(''); setFilter('all'); setModality('all') }} className="btn-outline btn-md">Clear filters</button>} />
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((s) => {
              const days = retentionDaysLeft(s.createdAt)
              const pctLeft = (days / 365) * 100
              return (
                <button
                  key={s.id}
                  onClick={() => navigate('study', { id: s.id })}
                  className="w-full text-left px-5 py-3.5 grid grid-cols-1 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_140px_130px_160px_40px] gap-2 lg:gap-4 lg:items-center hover:bg-slate-50/80 transition group"
                >
                  {/* patient */}
                  <div className="flex items-center gap-3 min-w-0">
                    <ModalityBadge modality={s.modality} size="sm" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[13.5px] font-medium text-slate-800 truncate">{s.patient.name}</p>
                        {s.priority === 'Urgent' && <I.Zap size={13} className="text-rose-500 shrink-0" />}
                      </div>
                      <p className="text-[12px] text-slate-400 font-mono truncate">
                        {s.id} · {s.patient.id} · {s.patient.age}
                        {s.patient.gender}
                      </p>
                    </div>
                  </div>

                  {/* exam */}
                  <div className="min-w-0 pl-[52px] lg:pl-0">
                    <p className="text-[13px] text-slate-700 truncate">
                      {s.modality} — {s.bodyPart}
                    </p>
                    <p className="text-[12px] text-slate-400 truncate">
                      {s.files.length ? `${s.files.length} file${s.files.length > 1 ? 's' : ''} · ${bytes(s.sizeBytes)} · ${s.images} images` : 'No images yet'}
                    </p>
                  </div>

                  {/* uploaded */}
                  <div className="pl-[52px] lg:pl-0">
                    <p className="text-[13px] text-slate-700">{timeAgo(s.createdAt)}</p>
                    <p className="text-[11.5px] text-slate-400">{dateTime(s.createdAt).split(',')[0]}</p>
                  </div>

                  {/* status */}
                  <div className="pl-[52px] lg:pl-0">
                    <StatusChip status={s.status} size="sm" />
                  </div>

                  {/* retention */}
                  <div className="pl-[52px] lg:pl-0">
                    {s.sizeBytes > 0 ? (
                      <>
                        <div className="flex items-center justify-between text-[11.5px] mb-1">
                          <span className="text-slate-500">Expires in {days}d</span>
                        </div>
                        <div className="h-1 w-full rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pctLeft < 10 ? 'bg-rose-500' : pctLeft < 30 ? 'bg-amber-500' : 'bg-brand-400'}`}
                            style={{ width: `${pctLeft}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <span className="text-[12px] text-slate-300">—</span>
                    )}
                  </div>

                  <div className="hidden lg:flex justify-end">
                    <I.ChevronRight size={16} className="text-slate-300 group-hover:text-brand-500 group-hover:translate-x-0.5 transition" />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <p className="text-[12px] text-slate-400 mt-4 flex items-center gap-1.5">
        <I.Clock size={13} /> Image files are deleted automatically 365 days after upload. Report text and study metadata are kept.
      </p>
    </Shell>
  )
}
