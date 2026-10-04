import { useEffect, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import { PACS, SCANNERS, suggestRadiologist } from '../data/seed'
import * as I from '../components/Icons'
import { ModalityBadge, StatusChip } from '../components/ui'
import { api } from '../live/api'
import { timeAgo } from '../lib/format'

const DEMO_PATIENTS = [
  { name: 'Anjali Kapoor', age: 44, gender: 'F' },
  { name: 'Sanjay Pillai', age: 63, gender: 'M' },
  { name: 'Farah Siddiqui', age: 37, gender: 'F' },
  { name: 'Rohit Bansal', age: 51, gender: 'M' },
]
const DEMO_EXAMS = { CT: ['Chest', 'Brain', 'Cardiac (Calcium score + CTA)'], MRI: ['Brain', 'Lumbar Spine', 'Knee'], 'X-Ray': ['Chest PA', 'Knee AP/LAT'] }

const Copy = ({ text }) => {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(String(text)).catch(() => {})
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="text-slate-400 hover:text-brand-600"
      title="Copy"
    >
      {done ? <I.Check size={14} /> : <I.Copy size={14} />}
    </button>
  )
}

/**
 * Scanners send studies straight to the PACS by DICOM (C-STORE). This screen shows
 * the address to configure on each machine, the machines the PACS accepts, and what
 * has arrived.
 */
export default function Scanners() {
  const { state, live, navigate, addStudy, notify, toast } = useStore()
  const [pacs, setPacs] = useState(live ? null : { ...PACS, online: true, scanners: SCANNERS })
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', aeTitle: '', host: '', port: 104 })
  const [adding, setAdding] = useState(false)
  const [echo, setEcho] = useState({})
  const [seq, setSeq] = useState(0)

  const reload = () =>
    api('/pacs')
      .then((p) => {
        setPacs(p)
        setError('')
      })
      .catch((e) => setError(e.message))

  useEffect(() => {
    if (live) reload()
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps

  const incoming = [...state.studies].filter((s) => s.receivedFrom).sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const register = async (e) => {
    e.preventDefault()
    const entry = { ...form, aeTitle: form.aeTitle.toUpperCase(), name: (form.name || form.aeTitle).toUpperCase(), port: Number(form.port) }
    if (!/^[A-Z0-9_ -]{1,16}$/.test(entry.aeTitle)) return toast('AE title: up to 16 letters, digits or _', 'error')
    if (!entry.host) return toast('Enter the scanner IP address', 'error')
    try {
      if (live) {
        await api('/pacs/scanners', { method: 'POST', body: entry })
        await reload()
      } else {
        setPacs((p) => ({ ...p, scanners: [...p.scanners, { ...entry, modality: '—', lastSeen: null }] }))
      }
      setForm({ name: '', aeTitle: '', host: '', port: 104 })
      setAdding(false)
      toast(`${entry.aeTitle} registered`, 'success', 'The PACS will now accept studies from this machine.')
    } catch (err) {
      toast('Could not register scanner', 'error', err.message)
    }
  }

  const remove = async (name) => {
    if (!window.confirm(`Stop accepting studies from ${name}?`)) return
    try {
      if (live) {
        await api(`/pacs/scanners/${encodeURIComponent(name)}`, { method: 'DELETE' })
        await reload()
      } else setPacs((p) => ({ ...p, scanners: p.scanners.filter((s) => s.name !== name) }))
    } catch (err) {
      toast('Could not remove scanner', 'error', err.message)
    }
  }

  const test = async (name) => {
    setEcho((e) => ({ ...e, [name]: { busy: true } }))
    try {
      const r = live ? await api(`/pacs/scanners/${encodeURIComponent(name)}/echo`, { method: 'POST' }) : await new Promise((res) => setTimeout(() => res({ ok: true, detail: 'C-ECHO succeeded (simulated)' }), 700))
      setEcho((e) => ({ ...e, [name]: r }))
    } catch (err) {
      setEcho((e) => ({ ...e, [name]: { ok: false, detail: err.message } }))
    }
  }

  // demo only: what the PACS does when a machine sends a study
  const simulate = (scanner) => {
    const n = seq + 1
    setSeq(n)
    const p = DEMO_PATIENTS[n % DEMO_PATIENTS.length]
    const modality = scanner.modality === '—' ? 'CT' : scanner.modality
    const exams = DEMO_EXAMS[modality] || ['Chest']
    const bodyPart = exams[n % exams.length]
    const images = modality === 'X-Ray' ? 2 : modality === 'MRI' ? 380 : bodyPart.startsWith('Cardiac') ? 176 : 420
    const id = `STD-${24818 + n}`
    const at = new Date().toISOString()
    const doc = suggestRadiologist(modality, bodyPart)
    addStudy({
      id,
      patient: { ...p, id: `PT-${10251 + n}`, phone: '', email: '' },
      modality,
      bodyPart,
      referredBy: '—',
      priority: 'Routine',
      assignedTo: doc.id,
      status: 'uploaded',
      createdAt: at,
      receivedFrom: { aeTitle: scanner.aeTitle, ip: scanner.host },
      files: [],
      sizeBytes: images * 524288,
      images,
      report: null,
      shares: [],
      timeline: [
        { id: 'ev_0', at, actor: scanner.aeTitle, text: `Received from ${scanner.aeTitle} (${scanner.host}) — ${images} images`, kind: 'upload' },
        { id: 'ev_1', at, actor: 'System', text: `Study complete — queued for ${doc.name}`, kind: 'db' },
      ],
    })
    setPacs((pc) => ({ ...pc, scanners: pc.scanners.map((s) => (s.name === scanner.name ? { ...s, lastSeen: at } : s)) }))
    notify({ title: 'New scan received', body: `${id} — ${p.name}, ${modality} ${bodyPart} from ${scanner.aeTitle}.`, kind: 'upload' })
    toast(`Scan received from ${scanner.aeTitle}`, 'success', `${p.name} · ${modality} ${bodyPart} · ${images} images`)
  }

  return (
    <Shell title="Scanners & incoming scans" subtitle="Machines send studies straight to the PACS — no manual upload">
      {error && (
        <div className="card p-4 mb-5 border-rose-200 bg-rose-50 text-[13px] text-rose-700">
          Cannot reach the PACS gateway: {error}
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="space-y-5">
          {/* the address to type into each machine */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[15px] font-semibold text-slate-900">PACS address for the scanners</h2>
              {pacs && (
                <span className={`chip ${pacs.online ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${pacs.online ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                  {pacs.online ? 'Receiving' : 'Offline'}
                </span>
              )}
            </div>
            <p className="text-[13px] text-slate-500 mb-4">
              On each machine, add a DICOM storage destination (often called <i>Store SCP</i>, <i>Remote node</i> or <i>Network destination</i>) with these values and
              set it as the auto-send target.
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              {[
                ['AE title', pacs?.aeTitle],
                ['IP address', pacs?.host],
                ['Port', pacs?.port],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-[11.5px] uppercase tracking-wider text-slate-400 font-semibold">{k}</p>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <p className="font-mono text-[17px] text-slate-900 truncate">{v ?? '…'}</p>
                    {v != null && <Copy text={v} />}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-slate-400 mt-3">Protocol DICOM C-STORE over TCP. Only machines registered below are accepted.</p>
          </div>

          {/* incoming */}
          <div className="card">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-[15px] font-semibold text-slate-900">Received from the scanners</h2>
              <span className="text-[12px] text-slate-400">{live ? 'Updates every 10 s' : `${incoming.length} received`}</span>
            </div>
            {incoming.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-slate-400">
                Nothing received yet. {live ? 'Send a study from a registered scanner.' : 'Use “Simulate scan” on a scanner to see one arrive.'}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {incoming.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => navigate('study', { id: s.id })} className="w-full flex items-center gap-3.5 px-5 py-3.5 text-left hover:bg-slate-50 transition">
                      <ModalityBadge modality={s.modality} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium text-slate-800 truncate">
                          {s.patient.name} <span className="text-slate-400 font-mono text-[12px] ml-1">{s.id}</span>
                        </p>
                        <p className="text-[12px] text-slate-500 truncate">
                          {s.modality} {s.bodyPart} · {s.images} images · from <span className="font-mono">{s.receivedFrom.aeTitle}</span> ({s.receivedFrom.ip})
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <StatusChip status={s.status} size="sm" />
                        <p className="text-[11.5px] text-slate-400 mt-1">{timeAgo(s.createdAt)}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* registered machines */}
        <div className="space-y-5">
          <div className="card">
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100">
              <h2 className="text-[14px] font-semibold text-slate-900">Registered scanners</h2>
              <button onClick={() => setAdding((a) => !a)} className="btn-ghost btn-sm">
                <I.UserPlus size={14} /> Add
              </button>
            </div>
            {adding && (
              <form onSubmit={register} className="p-4 border-b border-slate-100 space-y-2.5 bg-slate-50/60">
                <input className="input" placeholder="Scanner AE title (e.g. CT_ROOM1)" value={form.aeTitle} onChange={(e) => setForm({ ...form, aeTitle: e.target.value })} />
                <div className="grid grid-cols-[1fr_90px] gap-2">
                  <input className="input" placeholder="Scanner IP" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                  <input className="input" placeholder="Port" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </div>
                <input className="input" placeholder="Display name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <button className="btn-primary btn-sm w-full">Register scanner</button>
              </form>
            )}
            <ul className="divide-y divide-slate-100">
              {(pacs?.scanners || []).map((sc) => (
                <li key={sc.name} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-[13px] font-semibold text-slate-800">{sc.aeTitle}</p>
                    {sc.modality && sc.modality !== '—' && <span className="chip bg-slate-100 text-slate-500 !text-[10.5px]">{sc.modality}</span>}
                    <button onClick={() => remove(sc.name)} className="ml-auto text-slate-300 hover:text-rose-500" title="Remove">
                      <I.Trash size={14} />
                    </button>
                  </div>
                  <p className="text-[12px] text-slate-500 font-mono">{sc.host}:{sc.port}</p>
                  {sc.model && <p className="text-[11.5px] text-slate-400">{sc.model}</p>}
                  <p className="text-[11.5px] text-slate-400">{sc.lastSeen ? `Last study ${timeAgo(sc.lastSeen)}` : 'No studies yet'}</p>
                  <div className="flex gap-1.5 mt-2">
                    <button onClick={() => test(sc.name)} className="btn-outline btn-sm" disabled={echo[sc.name]?.busy}>
                      {echo[sc.name]?.busy ? 'Testing…' : 'Test (C-ECHO)'}
                    </button>
                    {!live && (
                      <button onClick={() => simulate(sc)} className="btn-ghost btn-sm">
                        <I.Zap size={14} /> Simulate scan
                      </button>
                    )}
                  </div>
                  {echo[sc.name] && !echo[sc.name].busy && (
                    <p className={`text-[11.5px] mt-1.5 ${echo[sc.name].ok ? 'text-emerald-600' : 'text-rose-600'}`}>{echo[sc.name].detail || (echo[sc.name].ok ? 'Reachable' : 'Not reachable')}</p>
                  )}
                </li>
              ))}
              {pacs && pacs.scanners.length === 0 && <li className="px-4 py-6 text-center text-[12.5px] text-slate-400">No scanners registered.</li>}
            </ul>
          </div>

          <div className="card p-4 text-[12.5px] text-slate-500 leading-relaxed">
            <p className="font-semibold text-slate-700 mb-1">How a scan reaches the radiologist</p>
            <ol className="list-decimal ml-4 space-y-1">
              <li>The technician finishes the scan; the machine sends it to the PACS.</li>
              <li>The study appears here and in Studies, assigned to a radiologist.</li>
              <li>Staff can send the images to any mobile number straight away.</li>
              <li>The radiologist reports; once signed, the report can be sent too.</li>
            </ol>
          </div>
        </div>
      </div>
    </Shell>
  )
}
