import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Shell from '../components/Shell'
import { useStore } from '../store'
import * as I from '../components/Icons'
import { EmptyState, ModalityBadge, Progress, StatusChip } from '../components/ui'
import { bytes } from '../lib/format'

const PART_SIZE = 8 * 1024 * 1024 // simulated multipart chunk
const MAX_PARALLEL_PARTS = 3
const TICK = 130

const partCount = (size) => Math.max(3, Math.min(12, Math.ceil(size / PART_SIZE)))

let fileSeq = 0

const makeFile = (f) => ({
  id: `f_${++fileSeq}`,
  name: f.name,
  size: f.size,
  type: f.type || 'application/octet-stream',
  status: 'queued', // queued | authorizing | uploading | error | done
  // willFail lives on the part itself so the tick below stays a pure state update
  parts: Array.from({ length: partCount(f.size) }, (_, i) => ({ i, pct: 0, status: 'pending', willFail: false })),
})

const ACCEPTED = ['.dcm', '.dicom', '.zip', '.jpg', '.jpeg', '.png', '.tif', '.tiff']

export default function UploadScreen() {
  const { state, navigate, updateStudy, toast, notify, pushEvent } = useStore()

  const candidates = useMemo(
    () => state.studies.filter((s) => s.status === 'draft' || s.status === 'uploading' || s.status === 'uploaded'),
    [state.studies]
  )
  const [studyId, setStudyId] = useState(state.route.params.id || candidates[0]?.id || state.studies[0]?.id)
  const study = state.studies.find((s) => s.id === studyId) || state.studies[0]

  const [files, setFiles] = useState([])
  const [dragging, setDragging] = useState(false)
  const [finalized, setFinalized] = useState(false)
  const inputRef = useRef(null)
  const dragDepth = useRef(0)
  const demoFailurePending = useRef(true)

  /* ---------- upload engine (simulated multipart) ---------- */
  useEffect(() => {
    const active = files.some((f) => f.status === 'uploading' || f.status === 'authorizing')
    if (!active) return

    const h = setInterval(() => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.status === 'authorizing') return { ...f, status: 'uploading' }
          if (f.status !== 'uploading') return f

          let parts = f.parts.map((p) => ({ ...p }))
          let inflight = parts.filter((p) => p.status === 'uploading').length

          // start new parts up to the parallel limit
          for (const p of parts) {
            if (inflight >= MAX_PARALLEL_PARTS) break
            if (p.status === 'pending') {
              p.status = 'uploading'
              inflight++
            }
          }

          // advance in-flight parts
          for (const p of parts) {
            if (p.status !== 'uploading') continue
            if (p.willFail && p.pct >= 45) {
              p.status = 'failed'
              p.willFail = false // a retry of this part succeeds
              continue
            }
            p.pct = Math.min(100, p.pct + 7 + Math.random() * 11)
            if (p.pct >= 100) {
              p.pct = 100
              p.status = 'done'
            }
          }

          const anyFailed = parts.some((p) => p.status === 'failed')
          const stillMoving = parts.some((p) => p.status === 'uploading' || p.status === 'pending')
          const allDone = parts.every((p) => p.status === 'done')

          let status = f.status
          if (allDone) status = 'done'
          else if (anyFailed && !stillMoving) status = 'error'

          return { ...f, parts, status }
        })
      )
    }, TICK)

    return () => clearInterval(h)
  }, [files])

  /* ---------- finalize once every file lands ---------- */
  useEffect(() => {
    // only files that have not already been written to the study record
    const pending = files.filter((f) => !f.committed)
    if (!pending.length || !pending.every((f) => f.status === 'done')) return

    const totalBytes = pending.reduce((a, f) => a + f.size, 0)
    const totalParts = pending.reduce((a, f) => a + f.parts.length, 0)
    const images = pending.reduce((a, f) => a + Math.max(1, Math.round(f.size / 524288)), 0)
    const ids = new Set(pending.map((f) => f.id))

    const t = setTimeout(() => {
      updateStudy(study.id, (s) => ({
        ...s,
        status: 'uploaded',
        files: [...s.files, ...pending.map((f) => ({ name: f.name, size: f.size, parts: f.parts.length }))],
        sizeBytes: s.sizeBytes + totalBytes,
        images: s.images + images,
      }))
      pushEvent(study.id, `${totalParts} parts uploaded directly to storage (${bytes(totalBytes)})`, 'upload', 'Priya Sharma')
      pushEvent(study.id, 'Object keys + metadata recorded, study queued for reporting', 'db', 'System')
      notify({ title: 'Upload complete', body: `${bytes(totalBytes)} stored for ${study.id} — ${study.patient.name}.`, kind: 'upload' })
      toast('Upload complete', 'success', `${bytes(totalBytes)} recorded against ${study.id}.`)
      setFiles((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, committed: true } : f)))
      setFinalized(true)
    }, 500)

    return () => clearTimeout(t)
  }, [files, study, updateStudy, pushEvent, notify, toast])

  /* ---------- adding files ---------- */
  const addFiles = useCallback(
    (list) => {
      const incoming = Array.from(list)
      if (!incoming.length) return
      setFinalized(false)
      const mapped = incoming.map(makeFile)
      // drop one part of the very first file so the retry path is visible
      if (demoFailurePending.current && mapped[0].parts.length > 2) {
        mapped[0].parts[2].willFail = true
        demoFailurePending.current = false
      }
      setFiles((prev) => [...prev, ...mapped])

      updateStudy(study.id, (s) => (s.status === 'draft' ? { ...s, status: 'uploading' } : s))
      pushEvent(
        study.id,
        `Upload authorized — ${mapped.reduce((a, f) => a + f.parts.length, 0)} presigned part URLs issued (valid 15 min)`,
        'auth',
        'System'
      )

      // brief "authorizing" beat, then parts start moving
      setTimeout(() => {
        setFiles((prev) => prev.map((f) => (mapped.find((m) => m.id === f.id) ? { ...f, status: 'authorizing' } : f)))
      }, 450)
    },
    [study, updateStudy, pushEvent]
  )

  const retryFile = (id) =>
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, status: 'uploading', parts: f.parts.map((p) => (p.status === 'failed' ? { ...p, status: 'uploading', pct: 0 } : p)) }
          : f
      )
    )

  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id))

  /* ---------- drag & drop ---------- */
  const onDragEnter = (e) => {
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault()
    dragDepth.current--
    if (dragDepth.current <= 0) setDragging(false)
  }
  const onDrop = (e) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const totals = useMemo(() => {
    const size = files.reduce((a, f) => a + f.size, 0)
    const parts = files.reduce((a, f) => a + f.parts.length, 0)
    const donePct = parts ? files.reduce((a, f) => a + f.parts.reduce((b, p) => b + (p.status === 'done' ? 100 : p.pct), 0), 0) / (parts * 100) * 100 : 0
    return { size, parts, donePct }
  }, [files])

  if (!study) {
    return (
      <Shell title="Upload images">
        <EmptyState icon={<I.Layers size={24} />} title="No studies yet" body="Register a patient study first, then come back to upload its images." action={<button onClick={() => navigate('new-study')} className="btn-primary btn-md"><I.UserPlus size={16} /> New study</button>} />
      </Shell>
    )
  }

  return (
    <Shell
      title="Upload images"
      subtitle="Files go straight from this browser into private storage — they never pass through the app server"
      actions={
        finalized ? (
          <button onClick={() => navigate('study', { id: study.id })} className="btn-primary btn-md">
            Open study <I.ArrowRight size={16} />
          </button>
        ) : null
      }
    >
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {/* Study picker */}
          <div className="card p-4">
            <label className="label">Uploading to</label>
            <div className="flex items-center gap-3">
              <ModalityBadge modality={study.modality} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-slate-800 truncate">
                  {study.patient.name} <span className="text-slate-400 font-mono text-[12px] ml-1">{study.id}</span>
                </p>
                <p className="text-[12.5px] text-slate-500 truncate">
                  {study.modality} · {study.bodyPart} · {study.patient.age}
                  {study.patient.gender}
                </p>
              </div>
              <select
                value={studyId}
                onChange={(e) => {
                  setStudyId(e.target.value)
                  setFiles([])
                  setFinalized(false)
                }}
                className="input !w-auto !h-10 text-[13px] max-w-[220px]"
              >
                {state.studies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} — {s.patient.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Dropzone */}
          <div
            onDragEnter={onDragEnter}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`relative rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
              dragging
                ? 'border-brand-500 bg-brand-50 scale-[1.01] shadow-pop'
                : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/40'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="px-6 py-12 text-center">
              <div
                className={`mx-auto h-16 w-16 rounded-2xl grid place-items-center transition-all duration-200 ${
                  dragging ? 'bg-brand-600 text-white scale-110' : 'bg-brand-50 text-brand-600'
                }`}
              >
                <I.Upload size={26} />
              </div>
              <p className="mt-4 text-[16px] font-semibold text-slate-900">
                {dragging ? 'Drop to start uploading' : 'Drag & drop DICOM files or a ZIP here'}
              </p>
              <p className="mt-1.5 text-[13px] text-slate-500">
                or <span className="text-brand-600 font-medium">browse from this computer</span> · {ACCEPTED.join(', ')}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-slate-400">
                <span className="flex items-center gap-1.5"><I.Layers size={13} /> Split into {bytes(PART_SIZE)} parts</span>
                <span className="flex items-center gap-1.5"><I.Refresh size={13} /> Failed parts retry individually</span>
                <span className="flex items-center gap-1.5"><I.Lock size={13} /> 15-minute upload permission</span>
              </div>
            </div>
          </div>

          {/* File queue */}
          {files.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[14.5px] font-semibold text-slate-900">Transfer queue</h2>
                  <span className="chip bg-slate-100 text-slate-500 !text-[11px]">{files.length} file{files.length > 1 ? 's' : ''} · {totals.parts} parts</span>
                </div>
                <span className="text-[13px] font-medium text-slate-600 tabular-nums">{Math.round(totals.donePct)}%</span>
              </div>

              <div className="divide-y divide-slate-100">
                {files.map((f) => {
                  const donePct = f.parts.reduce((a, p) => a + (p.status === 'done' ? 100 : p.pct), 0) / f.parts.length
                  const failedCount = f.parts.filter((p) => p.status === 'failed').length
                  return (
                    <div key={f.id} className="px-5 py-4 animate-fade-up">
                      <div className="flex items-start gap-3">
                        <div
                          className={`h-10 w-10 rounded-xl grid place-items-center shrink-0 ${
                            f.status === 'done'
                              ? 'bg-emerald-50 text-emerald-600'
                              : f.status === 'error'
                              ? 'bg-rose-50 text-rose-600'
                              : 'bg-brand-50 text-brand-600'
                          }`}
                        >
                          {f.status === 'done' ? <I.CheckCircle size={19} /> : f.status === 'error' ? <I.Alert size={19} /> : <I.Cloud size={19} />}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-[13.5px] font-medium text-slate-800 truncate">{f.name}</p>
                            <span className="text-[12px] text-slate-400 shrink-0">{bytes(f.size)}</span>
                          </div>

                          <p className="text-[12px] mt-0.5">
                            {f.status === 'queued' && <span className="text-slate-500">Waiting for upload permission…</span>}
                            {f.status === 'authorizing' && <span className="text-brand-600">Requesting presigned part URLs…</span>}
                            {f.status === 'uploading' && failedCount === 0 && (
                              <span className="text-slate-500">
                                Uploading {f.parts.filter((p) => p.status === 'done').length}/{f.parts.length} parts · {Math.round(donePct)}%
                              </span>
                            )}
                            {f.status === 'uploading' && failedCount > 0 && (
                              <span className="text-rose-600">
                                Part {f.parts.findIndex((p) => p.status === 'failed') + 1} dropped — the other parts are still going
                              </span>
                            )}
                            {f.status === 'error' && (
                              <span className="text-rose-600">
                                {failedCount} part{failedCount > 1 ? 's' : ''} failed — the rest are already stored
                              </span>
                            )}
                            {f.status === 'done' && <span className="text-emerald-600">Stored · all {f.parts.length} parts confirmed</span>}
                          </p>

                          {/* chunk grid */}
                          <div className="mt-2.5 flex flex-wrap gap-1">
                            {f.parts.map((p) => (
                              <div
                                key={p.i}
                                title={`Part ${p.i + 1} — ${p.status}`}
                                className={`h-6 w-8 rounded-md overflow-hidden relative transition-colors ${
                                  p.status === 'done'
                                    ? 'bg-emerald-500'
                                    : p.status === 'failed'
                                    ? 'bg-rose-500'
                                    : p.status === 'uploading'
                                    ? 'bg-brand-100'
                                    : 'bg-slate-100'
                                }`}
                              >
                                {p.status === 'uploading' && (
                                  <div className="absolute inset-y-0 left-0 bg-brand-500 transition-all duration-150" style={{ width: `${p.pct}%` }} />
                                )}
                                <span
                                  className={`absolute inset-0 grid place-items-center text-[9px] font-semibold ${
                                    p.status === 'done' || p.status === 'failed' ? 'text-white' : 'text-slate-400'
                                  }`}
                                >
                                  {p.i + 1}
                                </span>
                              </div>
                            ))}
                          </div>

                          <Progress
                            value={donePct}
                            tone={f.status === 'error' ? 'red' : f.status === 'done' ? 'green' : 'brand'}
                            className="mt-2.5"
                          />
                        </div>

                        <div className="shrink-0 flex items-center gap-1">
                          {failedCount > 0 && (
                            <button onClick={() => retryFile(f.id)} className="btn-outline btn-sm !border-rose-200 !text-rose-600 hover:!bg-rose-50 hover:!border-rose-300 animate-fade-in">
                              <I.Refresh size={14} /> Retry part {f.parts.findIndex((p) => p.status === 'failed') + 1}
                            </button>
                          )}
                          {(f.status === 'done' || f.status === 'queued') && (
                            <button onClick={() => removeFile(f.id)} className="btn-ghost h-8 w-8 rounded-lg text-slate-400 hover:text-rose-600">
                              <I.Trash size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {finalized && (
                <div className="px-5 py-4 bg-emerald-50/60 border-t border-emerald-100 flex items-center gap-3 animate-fade-up">
                  <div className="h-9 w-9 rounded-xl bg-emerald-500 text-white grid place-items-center shrink-0">
                    <I.Check size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium text-emerald-900">Recorded against {study.id}</p>
                    <p className="text-[12.5px] text-emerald-700/80">Object keys, size and status saved. The study is now in the radiologist's worklist.</p>
                  </div>
                  <button onClick={() => navigate('study', { id: study.id })} className="btn-primary btn-sm shrink-0">
                    Open study
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right rail */}
        <div className="space-y-5">
          <div className="card p-5">
            <h3 className="text-[15px] font-semibold text-slate-900 mb-1">This upload</h3>
            <p className="text-[12.5px] text-slate-500 mb-4">Live transfer summary.</p>

            <div className="space-y-3">
              {[
                ['Files queued', files.length],
                ['Total size', bytes(totals.size)],
                ['Parts', totals.parts],
                ['Completed', `${Math.round(totals.donePct)}%`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-[13px]">
                  <span className="text-slate-500">{k}</span>
                  <span className="font-medium text-slate-800 tabular-nums">{v}</span>
                </div>
              ))}
            </div>

            <Progress value={totals.donePct} className="mt-4 !h-2" tone={finalized ? 'green' : 'brand'} />
          </div>

          <div className="card p-5">
            <h3 className="text-[15px] font-semibold text-slate-900 mb-3.5">What happens to a file</h3>
            <ol className="space-y-3">
              {[
                ['Permission', 'The app checks you may upload to this study, then issues short-lived, single-purpose upload URLs.'],
                ['Direct transfer', 'The browser sends parts straight to storage. The app server never handles the image bytes.'],
                ['Resilience', 'Each part is confirmed on its own. A dropped part is retried alone, not the whole file.'],
                ['Record', 'Once every part is confirmed, the file location and size are written to the study record.'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3">
                  <span className="h-5 w-5 rounded-full bg-brand-50 text-brand-700 text-[11px] font-semibold grid place-items-center shrink-0 mt-0.5">{i + 1}</span>
                  <div>
                    <p className="text-[13px] font-medium text-slate-800">{t}</p>
                    <p className="text-[12.5px] text-slate-500 leading-relaxed">{d}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="card p-4 bg-slate-50/70">
            <div className="flex gap-2.5">
              <I.Alert size={16} className="text-slate-400 shrink-0 mt-0.5" />
              <p className="text-[12.5px] text-slate-500 leading-relaxed">
                Prototype: files stay in your browser and are never sent anywhere. Progress, part failures and retries are simulated.
              </p>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  )
}
