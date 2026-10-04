import { useEffect, useMemo, useState } from 'react'
import PlaneView from './PlaneView'
import { Progress } from './MprView'
import { useVolume } from './useVolume'
import { seriesMeta } from './series'
import * as I from '../components/Icons'
import { PHANTOM_ANATOMY } from '../imaging/phantom'
import { STAGES, VESSELS, cacCategory, runCacAnalysis } from '../cac/pipeline'
import { VERDICT_TEXT, validateSeries } from '../cac/validation'
import { applyOp, blockers, createReview, currentTotals } from '../cac/review'
import { dateTime } from '../lib/format'

export const VESSEL_COLOR = { LM: [192, 132, 252], LAD: [56, 189, 248], LCX: [251, 191, 36], RCA: [251, 113, 133] }
const NONE_COLOR = [255, 255, 255]
const EXCLUDED_COLOR = [148, 163, 184]
const DELETE_REASONS = ['False positive', 'Mitral annulus calcification', 'Aortic valve calcification', 'Noise / artefact', 'Bone', 'Other']

const r0 = (n) => (Number.isFinite(n) ? Math.round(n) : '—')
const r1 = (n) => (Math.round(n * 10) / 10).toFixed(1)
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))}`

/** Per-lesion voxel lists grouped by slice, so drawing a slice is cheap. */
function bySlice(lesions, plane) {
  const map = new Map()
  for (const l of lesions) {
    const m = new Map()
    for (const v of l.voxels || []) {
      const z = Math.floor(v / plane)
      if (!m.has(z)) m.set(z, [])
      m.get(z).push(v - z * plane)
    }
    map.set(l.id, m)
  }
  return map
}

export default function CacView(props) {
  const { series } = props
  const { vol, progress } = useVolume(series)
  if (!vol) return <Progress value={progress} label="Loading series for calcium analysis…" />
  return <Cac key={series.id} {...props} vol={vol} />
}

function Cac({ study, series, seriesList, onSeries, vol, tool, setTool, win, setWin, showOverlay, user, cac, onSave, toast }) {
  const n = vol.dims[0]
  const plane = n * vol.dims[1]
  const meta = useMemo(() => seriesMeta(series, study, vol), [series, study, vol])
  // the phantom's anatomy model applies to the phantom whether rendered locally or received over DICOM
  const anatomy = series.phantom || meta.Manufacturer === 'Asvanta phantom' ? PHANTOM_ANATOMY : null
  const validation = useMemo(
    () => validateSeries(meta, { slices: vol.dims[2], increment: vol.spacing[2] }, { anatomyModel: Boolean(anatomy) }),
    [meta, vol, anatomy]
  )

  const review = cac && cac.seriesId === series.id ? cac.review : null
  const otherReview = cac && cac.seriesId !== series.id ? cac : null
  const locked = review?.status === 'approved'

  const [slice, setSlice] = useState(() => (review?.lesions[0] ? Math.round(review.lesions[0].centroid[2]) : Math.floor(vol.dims[2] / 2)))
  const [view, setView] = useState({ zoom: 1.6, panX: -30, panY: 10 })
  const [selected, setSelected] = useState(null)
  const [action, setAction] = useState('select') // what a Point click does
  const [showAll, setShowAll] = useState(false)
  const [showExcluded, setShowExcluded] = useState(true)
  const [stages, setStages] = useState(null)
  const [running, setRunning] = useState(false)
  const [ackOpportunistic, setAckOpportunistic] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [approving, setApproving] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [erasing, setErasing] = useState(null) // Set of voxels pending removal during a drag
  const [openGroups, setOpenGroups] = useState({})

  useEffect(() => setSlice((s) => Math.min(vol.dims[2] - 1, s)), [vol])

  const lesionSlices = useMemo(() => (review ? bySlice(review.lesions, plane) : new Map()), [review, plane])
  const excludedSlices = useMemo(() => (review ? bySlice(review.excluded, plane) : new Map()), [review, plane])

  const img = useMemo(
    () => ({ data: vol.hu.subarray(slice * plane, (slice + 1) * plane), w: n, h: vol.dims[1], mmX: vol.spacing[0], mmY: vol.spacing[1] }),
    [vol, slice, plane, n]
  )

  const mask = useMemo(() => {
    const rgba = new Uint8ClampedArray(plane * 4)
    const paint = (p, [r, g, b], a) => {
      const o = p * 4
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = a
    }
    if (showAll) {
      const base = slice * plane
      for (let p = 0; p < plane; p++) if (vol.hu[base + p] >= 130) paint(p, [249, 115, 22], 70)
    }
    if (review) {
      if (showExcluded) {
        for (const l of review.excluded) for (const p of excludedSlices.get(l.id)?.get(slice) || []) paint(p, EXCLUDED_COLOR, l.id === selected ? 200 : 90)
      }
      for (const l of review.lesions) {
        const col = VESSEL_COLOR[l.vessel] || NONE_COLOR
        for (const p of lesionSlices.get(l.id)?.get(slice) || []) {
          if (erasing && l.id === selected && erasing.has(slice * plane + p)) continue
          paint(p, col, l.id === selected ? 235 : 150)
        }
      }
    }
    return rgba
  }, [review, lesionSlices, excludedSlices, slice, plane, showAll, showExcluded, selected, erasing, vol])

  const totals = review ? (review.summaryOnly ? review.approved.totals : currentTotals(review)) : null
  const block = review ? blockers(review) : null
  const selectedLesion = review?.lesions.find((l) => l.id === selected) || review?.excluded.find((l) => l.id === selected)

  const save = (next, event) => onSave({ seriesId: series.id, review: next }, event)

  const op = (o, event) => {
    try {
      const next = applyOp(review, o, { vol, user })
      save(next, event)
      return next
    } catch (e) {
      toast(e.message, 'error')
      return null
    }
  }

  const run = async () => {
    setRunning(true)
    setSelected(null)
    setStages(Object.fromEntries(STAGES.map((s) => [s.key, { status: 'waiting' }])))
    try {
      const result = await runCacAnalysis({
        vol,
        meta,
        anatomy,
        allowOpportunistic: ackOpportunistic,
        user,
        onStage: (key, status, detail) => setStages((st) => ({ ...st, [key]: { status, detail } })),
      })
      const rv = createReview(result, user)
      save(rv, `CAC analysis run on ${series.name} — algorithm score ${r0(result.totals.total)} (${result.kind}, unverified)`)
      if (result.lesions[0]) setSlice(Math.round(result.lesions[0].centroid[2]))
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setRunning(false)
    }
  }

  const jump = (l) => {
    setSelected(l.id)
    setSlice(Math.round((l.zRange[0] + l.zRange[1]) / 2))
  }

  const lesionAt = (pt) => {
    const c = Math.round(pt.c)
    const r = Math.round(pt.r)
    if (c < 0 || r < 0 || c >= n || r >= vol.dims[1]) return null
    const p = r * n + c
    const hit = (list, slices) => list.find((l) => (slices.get(l.id)?.get(slice) || []).includes(p))
    return { p, voxel: slice * plane + p, lesion: review && (hit(review.lesions, lesionSlices) || (showExcluded && hit(review.excluded, excludedSlices))) }
  }

  const onPoint = (pt, phase) => {
    if (!review || locked) return
    const at = lesionAt(pt)
    if (!at) return
    if (action === 'select' && phase === 'down') setSelected(at.lesion?.id || null)
    if (action === 'add' && phase === 'down') {
      if (at.lesion && review.lesions.includes(at.lesion)) return setSelected(at.lesion.id)
      const next = op({ type: 'add', seed: at.voxel }, null)
      if (next) {
        const added = next.lesions[next.lesions.length - 1]
        setSelected(added.id)
        toast(`Added ${added.id} · ${r1(added.score)}`, 'success', 'Assign it to a vessel in the lesion list.')
      }
    }
    if (action === 'erase') {
      if (phase === 'down' && (!selectedLesion || !review.lesions.includes(selectedLesion))) {
        toast('Select a lesion first, then erase part of it', 'info')
        return
      }
      if (phase === 'up') {
        if (erasing?.size) op({ type: 'erase', id: selected, voxels: [...erasing] }, null)
        setErasing(null)
        return
      }
      const own = new Set((lesionSlices.get(selected)?.get(slice) || []).map((q) => slice * plane + q))
      const nextSet = new Set(erasing || [])
      const rad = 1.6
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.hypot(dx, dy) > rad) continue
          const v = slice * plane + (Math.round(pt.r) + dy) * n + Math.round(pt.c) + dx
          if (own.has(v)) nextSet.add(v)
        }
      }
      setErasing(nextSet)
    }
  }

  const choose = (a) => {
    setAction(a)
    setTool('crosshair')
  }

  const approve = () => {
    setApproving(true)
    setTimeout(() => {
      try {
        const next = applyOp(review, { type: 'approve' }, { vol, user })
        const a = next.approved
        save(next, `CAC score approved: ${r0(a.totals.total)} (${a.category.code}) — algorithm ${r0(a.algorithmTotal)}, adjustment ${signed(a.delta)}`)
        toast('Final CAC score approved', 'success', 'It is now available to the report.')
      } catch (e) {
        toast(e.message, 'error')
      }
      setApproving(false)
      setConfirmApprove(false)
    }, 500)
  }

  const excludedGroups = useMemo(() => {
    const g = new Map()
    for (const x of review?.excluded || []) {
      if (!g.has(x.reason)) g.set(x.reason, [])
      g.get(x.reason).push(x)
    }
    return [...g.entries()]
  }, [review])

  const ctSeries = seriesList.filter((s) => s.count > 2)

  /* ------------------------------------------------------------- render */

  return (
    <div className="h-full w-full flex flex-col lg:flex-row min-h-0 overflow-y-auto lg:overflow-hidden">
      {/* CT slice with calcium overlay */}
      <div className="relative shrink-0 h-[55vh] lg:h-auto lg:flex-1 lg:min-h-0 flex">
        <div className="relative flex-1 min-w-0">
          <PlaneView
            img={img}
            win={win}
            view={view}
            onView={(c) => setView((v) => ({ ...v, ...c }))}
            onWin={setWin}
            tool={tool === 'crosshair' ? 'point' : tool}
            onScroll={(d) => setSlice((s) => Math.max(0, Math.min(vol.dims[2] - 1, s + d)))}
            onPoint={onPoint}
            mask={mask}
            cursor={tool === 'crosshair' ? (action === 'erase' ? 'cell' : action === 'add' ? 'copy' : 'pointer') : undefined}
          >
            {showOverlay && (
              <>
                <div className="absolute left-2.5 top-2 pointer-events-none font-mono text-[10px] sm:text-[11px] text-white/70 leading-[1.5]">
                  <div>{study.patient.name} · {study.patient.id}</div>
                  <div>{series.name}</div>
                  <div>Im {slice + 1}/{vol.dims[2]} · Z {(vol.z0 + slice * vol.spacing[2]).toFixed(1)} mm</div>
                  <div>{vol.spacing[2]} mm · {vol.spacing[0].toFixed(2)} mm/px</div>
                </div>
                <div className="absolute right-2.5 bottom-2 pointer-events-none flex flex-wrap gap-x-3 gap-y-1 justify-end text-[10.5px] font-mono">
                  {VESSELS.map((v) => (
                    <span key={v} className="flex items-center gap-1 text-white/80">
                      <span className="h-2 w-2 rounded-sm" style={{ background: `rgb(${VESSEL_COLOR[v].join(',')})` }} /> {v}
                    </span>
                  ))}
                  <span className="flex items-center gap-1 text-white/60">
                    <span className="h-2 w-2 rounded-sm bg-white" /> unassigned
                  </span>
                  {showExcluded && (
                    <span className="flex items-center gap-1 text-white/60">
                      <span className="h-2 w-2 rounded-sm bg-slate-400" /> excluded
                    </span>
                  )}
                </div>
                {selectedLesion && (
                  <div className="absolute left-2.5 bottom-2 pointer-events-none rounded-md bg-black/70 px-2.5 py-1.5 font-mono text-[10.5px] sm:text-[11px] text-white/85 leading-[1.6]">
                    <div className="font-semibold">{selectedLesion.id} · {selectedLesion.vessel || selectedLesion.reason || 'unassigned'}</div>
                    <div>Area {r1(selectedLesion.areaMm2)} mm² · peak {r0(selectedLesion.peakHu)} HU</div>
                    <div>Factor {selectedLesion.factor} · Agatston {r1(selectedLesion.score)}</div>
                    <div>Slices {selectedLesion.zRange[0] + 1}–{selectedLesion.zRange[1] + 1}</div>
                  </div>
                )}
              </>
            )}
          </PlaneView>
        </div>
        <div className="w-10 sm:w-8 shrink-0 bg-[#14171c] border-l border-black/50 flex flex-col items-center py-2 gap-2">
          <span className="text-[10px] font-mono text-slate-500">{slice + 1}</span>
          <input
            type="range"
            min="0"
            max={vol.dims[2] - 1}
            value={slice}
            onChange={(e) => setSlice(Number(e.target.value))}
            className="flex-1 accent-sky-500"
            style={{ writingMode: 'vertical-lr' }}
          />
          <span className="text-[10px] font-mono text-slate-500">{vol.dims[2]}</span>
        </div>
      </div>

      {/* analysis panel */}
      <aside className="lg:w-[390px] shrink-0 bg-[#14171c] border-t lg:border-t-0 lg:border-l border-black/50 lg:overflow-y-auto text-[12.5px]">
        <div className="p-4 border-b border-white/5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">Coronary calcium analysis</h2>
            <span
              className={`chip text-[10.5px] ${
                locked ? 'bg-emerald-500/15 text-emerald-300' : review ? 'bg-amber-500/15 text-amber-300' : 'bg-white/10 text-slate-400'
              }`}
            >
              {locked ? 'Approved' : review ? 'In review · unverified' : 'Not run'}
            </span>
          </div>
          <label className="mt-3 block">
            <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Series</span>
            <select
              value={series.id}
              onChange={(e) => onSeries(e.target.value)}
              className="mt-1 w-full rounded-md bg-[#0e1014] border border-white/10 px-2 py-1.5 text-[12.5px] text-slate-200"
            >
              {ctSeries.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {otherReview && (
            <p className="mt-2 text-[11.5px] text-amber-300/90">
              The {otherReview.review.status === 'approved' ? 'approved' : 'current'} analysis is on another series.
              <button onClick={() => onSeries(otherReview.seriesId)} className="ml-1 underline">Open it</button>
            </p>
          )}
        </div>

        {/* validation */}
        {(!review || !locked) && (
          <Section key={review ? 'validated' : 'fresh'} title="Scan validation" defaultOpen={!review}>
            <ul className="space-y-1.5">
              {validation.checks.map((c) => (
                <li key={c.id} className="flex gap-2">
                  <span className={`mt-0.5 shrink-0 ${c.status === 'pass' ? 'text-emerald-400' : c.status === 'warn' ? 'text-amber-400' : c.status === 'info' ? 'text-sky-400' : 'text-rose-400'}`}>
                    {c.status === 'pass' ? <I.Check size={14} /> : c.status === 'warn' || c.status === 'info' ? <I.Alert size={14} /> : <I.X size={14} />}
                  </span>
                  <span className="min-w-0">
                    <span className="text-slate-200">{c.label}</span>
                    <span className="block text-[11px] text-slate-500 leading-snug">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div
              className={`mt-3 rounded-lg border p-3 ${
                validation.verdict === 'ready'
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : validation.verdict === 'opportunistic'
                    ? 'border-amber-500/30 bg-amber-500/10'
                    : 'border-rose-500/30 bg-rose-500/10'
              }`}
            >
              <p className={`text-[12px] font-semibold uppercase tracking-wider ${validation.verdict === 'ready' ? 'text-emerald-300' : validation.verdict === 'opportunistic' ? 'text-amber-300' : 'text-rose-300'}`}>
                {VERDICT_TEXT[validation.verdict].title}
              </p>
              <p className="text-[11.5px] text-slate-300 mt-1 leading-snug">{VERDICT_TEXT[validation.verdict].body}</p>
              {validation.verdict === 'opportunistic' && (
                <label className="mt-2 flex items-start gap-2 text-[11.5px] text-slate-200">
                  <input type="checkbox" checked={ackOpportunistic} onChange={(e) => setAckOpportunistic(e.target.checked)} className="mt-0.5 accent-amber-500" />
                  I understand the result is an opportunistic estimate, not a standard Agatston score.
                </label>
              )}
            </div>
            {validation.verdict !== 'unsuitable' && !locked && (
              <button
                onClick={() => {
                  if (review && !window.confirm('Replace the analysis in review? Unapproved edits to the current lesion list will be discarded.')) return
                  run()
                }}
                disabled={running || (validation.verdict === 'opportunistic' && !ackOpportunistic)}
                className="mt-3 w-full rounded-lg bg-sky-600 py-2 text-[12.5px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {running ? 'Analysing…' : review ? 'Re-run analysis' : validation.verdict === 'opportunistic' ? 'Run opportunistic estimate' : 'Run CAC analysis'}
              </button>
            )}
          </Section>
        )}

        {/* pipeline progress */}
        {stages && running && (
          <Section title="Pipeline" defaultOpen>
            <ol className="space-y-1">
              {STAGES.map((s) => {
                const st = stages[s.key] || {}
                return (
                  <li key={s.key} className="flex items-start gap-2">
                    <span className="w-4 shrink-0 mt-0.5">
                      {st.status === 'done' ? (
                        <I.Check size={13} className="text-emerald-400" />
                      ) : st.status === 'running' ? (
                        <span className="block h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                      ) : st.status === 'failed' ? (
                        <I.X size={13} className="text-rose-400" />
                      ) : (
                        <span className="block h-1.5 w-1.5 rounded-full bg-slate-600 mt-1 ml-1" />
                      )}
                    </span>
                    <span>
                      <span className={st.status ? 'text-slate-200' : 'text-slate-500'}>{s.label}</span>
                      {st.detail && <span className="block text-[10.5px] text-slate-500">{st.detail}</span>}
                    </span>
                  </li>
                )
              })}
            </ol>
          </Section>
        )}

        {review && (
          <>
            {/* scores */}
            <div className="p-4 border-b border-white/5">
              <div className={`mb-3 rounded-md px-2.5 py-1.5 text-[11px] ${review.algorithm.kind === 'standard' ? 'bg-sky-500/10 text-sky-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {review.algorithm.kind === 'standard' ? 'Standard Agatston analysis (dedicated CAC series)' : 'Opportunistic estimate — not a standard Agatston score'}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-white/10 p-2.5">
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Algorithm</p>
                  <p className="text-[24px] font-semibold text-slate-300 leading-tight font-mono">{r0(review.algorithm.totals.total)}</p>
                  <p className="text-[10.5px] text-slate-500">unverified · {review.algorithm.engineVersion}</p>
                </div>
                <div className={`rounded-lg border p-2.5 ${locked ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-sky-500/30 bg-sky-500/5'}`}>
                  <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400">{locked ? 'Final approved' : 'Radiologist (working)'}</p>
                  <p className="text-[24px] font-semibold text-white leading-tight font-mono">{r0(totals.total)}</p>
                  <p className="text-[10.5px] text-slate-400">
                    {cacCategory(totals.total).code} · {signed(totals.total - review.algorithm.totals.total)}
                  </p>
                </div>
              </div>
              <table className="mt-3 w-full font-mono text-[12px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left font-normal py-1">Vessel</th>
                    <th className="text-right font-normal">Algorithm</th>
                    <th className="text-right font-normal">{locked ? 'Final' : 'Working'}</th>
                  </tr>
                </thead>
                <tbody>
                  {VESSELS.map((v) => (
                    <tr key={v} className="border-t border-white/5">
                      <td className="py-1">
                        <span className="inline-block h-2 w-2 rounded-sm mr-2" style={{ background: `rgb(${VESSEL_COLOR[v].join(',')})` }} />
                        {v}
                      </td>
                      <td className="text-right text-slate-400">{r0(review.algorithm.totals[v])}</td>
                      <td className="text-right text-slate-100">{r0(totals[v])}</td>
                    </tr>
                  ))}
                  {(review.algorithm.totals.unassigned > 0 || totals.unassigned > 0) && (
                    <tr className="border-t border-white/5 text-amber-300">
                      <td className="py-1">Unassigned</td>
                      <td className="text-right">{r0(review.algorithm.totals.unassigned || 0)}</td>
                      <td className="text-right">{r0(totals.unassigned)}</td>
                    </tr>
                  )}
                  <tr className="border-t border-white/15 font-semibold">
                    <td className="py-1">Total</td>
                    <td className="text-right text-slate-400">{r0(review.algorithm.totals.total)}</td>
                    <td className="text-right text-white">{r0(totals.total)}</td>
                  </tr>
                </tbody>
              </table>
              {locked && (
                <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-2.5 text-[11.5px] text-emerald-200 leading-relaxed">
                  Approved by <b>{review.approved.approvedBy}</b> · {dateTime(review.approved.approvedAt)}
                  <br />
                  Locked. The final score is available to the report.
                </div>
              )}
            </div>

            {/* actions */}
            {!locked && (
              <div className="p-4 border-b border-white/5">
                <div className="grid grid-cols-3 gap-1.5">
                  <ActionBtn onClick={() => op({ type: 'accept-all' }, null)} icon={I.CheckCircle} label="Accept all" disabled={!block.pending.length} />
                  <ActionBtn onClick={() => choose('add')} icon={I.UserPlus} label="Add lesion" active={action === 'add' && tool === 'crosshair'} />
                  <ActionBtn onClick={() => choose('erase')} icon={I.Pencil} label="Erase" active={action === 'erase' && tool === 'crosshair'} />
                  <ActionBtn onClick={() => choose('select')} icon={I.Search} label="Select" active={action === 'select' && tool === 'crosshair'} />
                  <ActionBtn onClick={() => op({ type: 'recalculate' }, null)} icon={I.Refresh} label="Recalculate" />
                  <ActionBtn
                    onClick={() => setShowAll((v) => !v)}
                    icon={I.Eye}
                    label="≥130 HU"
                    active={showAll}
                  />
                </div>
                <p className="mt-2 text-[11px] text-slate-500 leading-snug">
                  {action === 'add'
                    ? 'Click calcium (≥130 HU) on the image to add a missed lesion.'
                    : action === 'erase'
                      ? 'Select a lesion, then drag over the part to remove on this slice.'
                      : 'Click a highlighted lesion to select it. Scroll to change slice.'}
                </p>
                <button
                  onClick={() => setConfirmApprove(true)}
                  disabled={!block.ok}
                  className="mt-3 w-full rounded-lg bg-emerald-600 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  Approve final score
                </button>
                {!block.ok && (
                  <p className="mt-1.5 text-[11px] text-amber-300/90">
                    {block.pending.length ? `${block.pending.length} lesion${block.pending.length > 1 ? 's' : ''} to review` : ''}
                    {block.pending.length && block.unassigned.length ? ' · ' : ''}
                    {block.unassigned.length ? `${block.unassigned.length} without a vessel` : ''}
                  </p>
                )}
              </div>
            )}

            {/* lesions */}
            <Section title={`Detected lesions (${review.lesions.length})`} defaultOpen>
              {review.lesions.length === 0 && <p className="text-slate-500">No coronary calcium lesions.</p>}
              <ul className="space-y-1.5">
                {review.lesions.map((l) => (
                  <li
                    key={l.id}
                    className={`rounded-lg border p-2 transition ${selected === l.id ? 'border-sky-500/60 bg-sky-500/10' : 'border-white/10 hover:border-white/20'}`}
                  >
                    <div className="flex items-center gap-2">
                      <button onClick={() => jump(l)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                        <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: `rgb(${(VESSEL_COLOR[l.vessel] || NONE_COLOR).join(',')})` }} />
                        <span className="font-mono text-slate-200">{l.id}</span>
                        {l.source !== 'algorithm' && <span className="chip bg-white/10 text-slate-300 text-[9.5px] !py-0">{l.source}</span>}
                        <span className="ml-auto font-mono text-white">{r1(l.score)}</span>
                      </button>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 font-mono text-[10.5px] text-slate-500">
                      <span>{r1(l.areaMm2)} mm²</span>·<span>{r0(l.peakHu)} HU</span>·<span>×{l.factor}</span>·<span>Im {l.zRange[0] + 1}{l.zRange[1] !== l.zRange[0] ? `–${l.zRange[1] + 1}` : ''}</span>
                    </div>
                    {!locked && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <select
                          value={l.vessel || ''}
                          onChange={(e) => op({ type: 'vessel', id: l.id, vessel: e.target.value }, null)}
                          className={`rounded bg-[#0e1014] border px-1.5 py-1 text-[11.5px] ${l.vessel ? 'border-white/10 text-slate-200' : 'border-amber-500/50 text-amber-300'}`}
                        >
                          <option value="" disabled>Vessel…</option>
                          {VESSELS.map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                        {l.status === 'accepted' ? (
                          <span className="text-[11px] text-emerald-400 flex items-center gap-1"><I.Check size={12} /> accepted</span>
                        ) : (
                          <button onClick={() => op({ type: 'accept', id: l.id }, null)} className="rounded border border-emerald-500/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">
                            Accept
                          </button>
                        )}
                        <button onClick={() => setDeleting(deleting === l.id ? null : l.id)} className="ml-auto rounded p-1 text-slate-400 hover:text-rose-300 hover:bg-rose-500/10" title="Delete lesion">
                          <I.Trash size={14} />
                        </button>
                      </div>
                    )}
                    {deleting === l.id && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {DELETE_REASONS.map((reason) => (
                          <button
                            key={reason}
                            onClick={() => {
                              op({ type: 'delete', id: l.id, reason }, null)
                              setDeleting(null)
                              if (selected === l.id) setSelected(null)
                            }}
                            className="rounded-full border border-rose-500/40 px-2 py-0.5 text-[10.5px] text-rose-200 hover:bg-rose-500/15"
                          >
                            {reason}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            {/* excluded */}
            <Section title={`Excluded candidates (${review.excluded.length})`}>
              <label className="flex items-center gap-2 text-[11.5px] text-slate-400 mb-2">
                <input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} className="accent-sky-500" />
                Show on image (grey)
              </label>
              {excludedGroups.map(([reason, items]) => {
                const open = openGroups[reason] ?? !reason.startsWith('Bone')
                return (
                  <div key={reason} className="mb-2">
                    <button onClick={() => setOpenGroups((g) => ({ ...g, [reason]: !open }))} className="flex w-full items-center gap-1.5 text-[11.5px] text-slate-300">
                      <I.ChevronRight size={13} className={`transition ${open ? 'rotate-90' : ''}`} />
                      {reason} <span className="text-slate-500">· {items.length}</span>
                    </button>
                    {open && (
                      <ul className="mt-1 ml-4 space-y-1">
                        {items.map((x) => (
                          <li key={x.id} className={`flex items-center gap-2 rounded px-1.5 py-1 ${selected === x.id ? 'bg-white/10' : ''}`}>
                            <button onClick={() => jump(x)} className="flex-1 text-left font-mono text-[11px] text-slate-400 hover:text-slate-200">
                              {x.id} · {r1(x.score)} · {r0(x.peakHu)} HU · Im {x.zRange[0] + 1}
                            </button>
                            {!locked && (
                              <button onClick={() => op({ type: 'restore', id: x.id }, null)} className="rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] text-slate-300 hover:bg-white/10">
                                Restore
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </Section>

            {/* audit */}
            <Section title={`Audit trail (${review.audit.length})`}>
              <ol className="space-y-2">
                {review.audit.map((a, i) => (
                  <li key={i} className="border-l-2 border-white/10 pl-2.5">
                    <p className="text-slate-200">
                      {a.action}
                      {Math.abs(a.delta) >= 0.5 && <span className={`ml-1.5 font-mono text-[11px] ${a.delta < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{signed(a.delta)}</span>}
                    </p>
                    <p className="text-[11px] text-slate-500">{a.detail}</p>
                    <p className="text-[10.5px] text-slate-600">{a.user} · {dateTime(a.at)}</p>
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}

        <p className="p-4 text-[10.5px] text-slate-600 leading-relaxed">
          Algorithm output assists the radiologist and is never a clinical result until approved. Anatomy in this demo comes from a
          phantom model standing in for heart segmentation and coronary centerline extraction. Not validated for clinical use.
        </p>
      </aside>

      {confirmApprove && review && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" onClick={() => !approving && setConfirmApprove(false)}>
          <div className="absolute inset-0 bg-black/70" />
          <div className="relative w-full max-w-md rounded-2xl bg-[#181c22] border border-white/10 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-white">Approve final CAC score?</h3>
            <p className="text-[12.5px] text-slate-400 mt-1">{study.patient.name} · {study.id} · {series.name}</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Stat label="Algorithm" value={r0(review.algorithm.totals.total)} />
              <Stat label="Adjustment" value={signed(totals.total - review.algorithm.totals.total)} />
              <Stat label="Final" value={r0(totals.total)} strong />
            </div>
            <p className="mt-3 text-[12.5px] text-slate-300">
              LM {r0(totals.LM)} · LAD {r0(totals.LAD)} · LCX {r0(totals.LCX)} · RCA {r0(totals.RCA)} — {cacCategory(totals.total).code} ({cacCategory(totals.total).label.toLowerCase()})
            </p>
            {review.algorithm.kind === 'opportunistic' && (
              <p className="mt-2 text-[12px] text-amber-300">Will be reported as an opportunistic estimate, not a standard Agatston score.</p>
            )}
            <ul className="mt-3 space-y-1.5 text-[12px] text-slate-400">
              <li>• Your name, the time and {review.algorithm.engineVersion} are recorded with the score.</li>
              <li>• The algorithm result and every change stay in the audit trail.</li>
              <li>• The analysis is locked; the final score becomes available to the report.</li>
            </ul>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setConfirmApprove(false)} disabled={approving} className="flex-1 rounded-lg border border-white/15 py-2 text-[12.5px] text-slate-300 hover:bg-white/5">
                Back to review
              </button>
              <button onClick={approve} disabled={approving} className="flex-1 rounded-lg bg-emerald-600 py-2 text-[12.5px] font-semibold text-white hover:bg-emerald-500">
                {approving ? 'Approving…' : `Approve ${r0(totals.total)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-400 hover:text-slate-200">
        <I.ChevronRight size={13} className={`transition ${open ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

const ActionBtn = ({ icon: Icon, label, onClick, disabled, active }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex flex-col items-center gap-1 rounded-lg border py-2 text-[10.5px] transition disabled:opacity-35 ${
      active ? 'border-sky-500/60 bg-sky-500/15 text-sky-200' : 'border-white/10 text-slate-300 hover:bg-white/5'
    }`}
  >
    <Icon size={15} />
    {label}
  </button>
)

const Stat = ({ label, value, strong }) => (
  <div className={`rounded-lg border p-2 ${strong ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10'}`}>
    <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
    <p className={`font-mono text-[20px] ${strong ? 'text-white font-semibold' : 'text-slate-300'}`}>{value}</p>
  </div>
)
