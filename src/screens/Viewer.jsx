import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import * as I from '../components/Icons'
import Viewport from '../viewer/Viewport'
import SeriesThumb from '../viewer/SeriesThumb'
import { buildSeries, presetsFor } from '../viewer/series'
import { dateTime } from '../lib/format'

const TOOLS = [
  { key: 'stack', label: 'Stack', icon: I.Layers, hint: 'Drag up/down to scroll slices' },
  { key: 'zoom', label: 'Zoom', icon: I.Search, hint: 'Drag up/down to zoom' },
  { key: 'pan', label: 'Pan', icon: I.Share, hint: 'Drag to move the image' },
  { key: 'wl', label: 'W / L', icon: I.Eye, hint: 'Drag: left–right width, up–down level' },
  { key: 'measure', label: 'Measure', icon: I.Pencil, hint: 'Drag to measure a distance in mm' },
]

const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

const SHORTCUTS = [
  ['1 – 5', 'Stack, Zoom, Pan, W/L, Measure'],
  ['Wheel / ↑ ↓', 'Previous or next slice'],
  ['Home / End', 'First or last slice'],
  ['Space', 'Play or pause cine'],
  ['R', 'Reset the viewport'],
  ['I', 'Invert greyscale'],
  ['O', 'Show or hide the overlay'],
  ['G', 'Toggle 1×1 and 2×2 layout'],
  ['Right-drag', 'Window / level from any tool'],
  ['Middle-drag', 'Pan from any tool'],
  ['Esc', 'Close the viewer'],
]

const newViewport = (series, plane) => ({
  seriesIdx: 0,
  slice: Math.floor(series.count / 2),
  zoom: 1,
  panX: 0,
  panY: 0,
  ww: series.ww,
  wc: series.wc,
  invert: false,
  rotate: 0,
  plane: plane || series.plane,
  measurements: [],
})

const Group = ({ label, children }) => (
  <div className="flex flex-col items-center px-2.5 border-r border-white/10 last:border-0">
    <span className="text-[9px] uppercase tracking-[0.14em] text-slate-500 mb-0.5">{label}</span>
    <div className="flex items-end gap-0.5">{children}</div>
  </div>
)

const Tool = ({ icon: Icon, label, active, badge, onClick, disabled, title }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title || label}
    className={`relative flex flex-col items-center gap-0.5 rounded-md px-2 py-1 min-w-[46px] transition disabled:opacity-30 ${
      active ? 'bg-sky-500/20 text-sky-300' : 'text-slate-300 hover:bg-white/10 hover:text-white'
    }`}
  >
    <Icon size={17} />
    <span className="text-[10px] leading-none">{label}</span>
    {badge && (
      <span className="absolute -top-0.5 right-1 h-3.5 w-3.5 rounded-full bg-sky-500 text-[8px] font-bold text-white grid place-items-center">
        {badge}
      </span>
    )}
  </button>
)

export default function Viewer() {
  const { state, navigate, getStudy } = useStore()
  const study = getStudy(state.route.params.id) || state.studies[0]
  const seriesList = useMemo(() => buildSeries(study), [study])
  const presets = presetsFor(study.modality)

  const [layout, setLayout] = useState('1x1')
  const [activeVp, setActiveVp] = useState(0)
  const [tool, setTool] = useState('stack')
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(12)
  const [showOverlay, setShowOverlay] = useState(true)
  const [showRail, setShowRail] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [showShortcuts, setShowShortcuts] = useState(false)
  // open on the largest series — a 1-image scout is never what you want to land on
  const defaultOrder = useMemo(() => {
    const bySize = seriesList.map((s, i) => i).sort((a, b) => seriesList[b].count - seriesList[a].count)
    return [0, 1, 2, 3].map((n) => bySize[n % bySize.length])
  }, [seriesList])

  const [viewports, setViewports] = useState(() =>
    defaultOrder.map((idx) => ({ ...newViewport(seriesList[idx]), seriesIdx: idx }))
  )

  const count = layout === '1x1' ? 1 : 4
  const vp = viewports[activeVp]
  const activeSeries = seriesList[vp.seriesIdx]

  const patch = useCallback((idx, changes) => {
    setViewports((prev) => prev.map((v, i) => (i === idx ? { ...v, ...changes } : v)))
  }, [])

  const loadSeries = (seriesIdx) => {
    const s = seriesList[seriesIdx]
    patch(activeVp, { ...newViewport(s), seriesIdx })
  }

  const resetVp = () => patch(activeVp, { ...newViewport(activeSeries), seriesIdx: vp.seriesIdx })

  /* cine */
  useEffect(() => {
    if (!playing) return
    const h = setInterval(() => {
      setViewports((prev) =>
        prev.map((v, i) => (i === activeVp ? { ...v, slice: (v.slice + 1) % seriesList[v.seriesIdx].count } : v))
      )
    }, 1000 / fps)
    return () => clearInterval(h)
  }, [playing, fps, activeVp, seriesList])

  /* warm the slice cache for the active series so cine and scrolling stay smooth */
  useEffect(() => {
    let cancelled = false
    let i = 0
    const idle = window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16))
    const step = (deadline) => {
      import('../viewer/synth').then(({ sliceData }) => {
        while (i < activeSeries.count && !cancelled && deadline.timeRemaining() > 3) {
          sliceData(activeSeries.anatomy, activeSeries.seed, i, activeSeries.count, 384, activeSeries.mri)
          i++
        }
        if (i < activeSeries.count && !cancelled) idle(step)
      })
    }
    idle(step)
    return () => { cancelled = true }
  }, [activeSeries])

  /* keyboard */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const s = seriesList[viewports[activeVp].seriesIdx]
      const step = (d) => patch(activeVp, { slice: Math.max(0, Math.min(s.count - 1, viewports[activeVp].slice + d)) })
      const map = { '1': 'stack', '2': 'zoom', '3': 'pan', '4': 'wl', '5': 'measure' }
      if (map[e.key]) return setTool(map[e.key])
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': e.preventDefault(); return step(1)
        case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); return step(-1)
        case 'Home': return patch(activeVp, { slice: 0 })
        case 'End': return patch(activeVp, { slice: s.count - 1 })
        case ' ': e.preventDefault(); return setPlaying((p) => !p)
        case 'r': case 'R': return resetVp()
        case 'i': case 'I': return patch(activeVp, { invert: !viewports[activeVp].invert })
        case 'o': case 'O': return setShowOverlay((v) => !v)
        case 'g': case 'G': return setLayout((l) => (l === '1x1' ? '2x2' : '1x1'))
        case '?': return setShowShortcuts((v) => !v)
        case 'Escape': return showShortcuts ? setShowShortcuts(false) : navigate('study', { id: study.id })
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const presetActive = presets.find((p) => Math.abs(p.ww - vp.ww) < 1 && Math.abs(p.wc - vp.wc) < 1)

  return (
    <div className="h-screen flex flex-col bg-[#0b0d10] text-slate-200 select-none">
      {/* toolbar */}
      <div className="h-[58px] shrink-0 bg-[#14171c] border-b border-black/50 flex items-stretch overflow-hidden">
        <button
          onClick={() => navigate('study', { id: study.id })}
          className="flex items-center gap-2 px-3 sm:px-4 shrink-0 text-[13px] text-slate-300 hover:bg-white/5 border-r border-white/10 transition"
        >
          <I.ArrowLeft size={17} />
          <span className="hidden sm:inline">Study</span>
        </button>

        <div className="flex items-stretch overflow-x-auto min-w-0 flex-1">
          <Group label="Mouse tools">
            {TOOLS.map((t) => (
              <Tool key={t.key} icon={t.icon} label={t.label} active={tool === t.key} onClick={() => setTool(t.key)} title={`${t.label} — ${t.hint}`} />
            ))}
          </Group>

          <Group label="Annotate">
            <Tool
              icon={I.Trash}
              label="Clear"
              disabled={!vp.measurements.length}
              onClick={() => patch(activeVp, { measurements: [] })}
              title="Remove all measurements in this viewport"
            />
          </Group>

          <Group label="Layout">
            <Tool icon={I.Image} label="1×1" active={layout === '1x1'} onClick={() => setLayout('1x1')} />
            <Tool icon={I.Grid} label="2×2" active={layout === '2x2'} onClick={() => setLayout('2x2')} />
            <Tool icon={I.Refresh} label="Rotate" onClick={() => patch(activeVp, { rotate: (vp.rotate + 90) % 360 })} />
            <Tool icon={I.Eye} label="Invert" active={vp.invert} onClick={() => patch(activeVp, { invert: !vp.invert })} />
          </Group>

          <Group label="Window">
            {presets.map((p) => (
              <button
                key={p.name}
                onClick={() => patch(activeVp, { ww: p.ww, wc: p.wc })}
                className={`rounded-md px-2.5 h-[30px] text-[11px] font-medium transition ${
                  presetActive?.name === p.name ? 'bg-sky-500/20 text-sky-300' : 'text-slate-300 hover:bg-white/10'
                }`}
              >
                {p.name}
              </button>
            ))}
          </Group>

          <Group label="Cine">
            <Tool icon={playing ? I.Pause : I.Play} label={playing ? 'Pause' : 'Play'} active={playing} onClick={() => setPlaying((p) => !p)} />
            <div className="flex flex-col items-center px-1.5">
              <input
                type="range"
                min="2"
                max="30"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-20 accent-sky-500"
              />
              <span className="text-[10px] text-slate-400 leading-none">{fps} fps</span>
            </div>
          </Group>

          <Group label="View">
            <Tool icon={I.FileText} label="Overlay" active={showOverlay} onClick={() => setShowOverlay((v) => !v)} />
            <Tool icon={I.Layers} label="Series" active={showRail} onClick={() => setShowRail((v) => !v)} />
            <Tool icon={I.Refresh} label="Reset" onClick={resetVp} />
            <Tool icon={I.Alert} label="Keys" active={showShortcuts} onClick={() => setShowShortcuts((v) => !v)} />
          </Group>
        </div>

        <div className="hidden md:flex items-center gap-3 px-4 border-l border-white/10 shrink-0">
          <div className="text-right hidden md:block">
            <p className="text-[12.5px] font-medium text-slate-200 leading-tight">{study.patient.name}</p>
            <p className="text-[11px] text-slate-500 font-mono leading-tight">{study.id}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* series rail — an overlay on phones, a column from lg up */}
        {showRail && (
          <>
            <div className="lg:hidden absolute inset-0 z-20 bg-black/60" onClick={() => setShowRail(false)} />
            <div className="absolute lg:relative inset-y-0 left-0 z-30 w-[118px] lg:w-[132px] shrink-0 bg-[#14171c] border-r border-black/50 overflow-y-auto p-2 space-y-2">
            {seriesList.map((s, i) => {
              const isActive = vp.seriesIdx === i
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    loadSeries(i)
                    if (window.innerWidth < 1024) setShowRail(false)
                  }}
                  className={`w-full rounded-md overflow-hidden border transition ${
                    isActive ? 'border-sky-500 ring-1 ring-sky-500/50' : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  <div className="px-1.5 py-1 text-[10px] text-slate-300 leading-tight truncate text-left">{s.name}</div>
                  <div className="relative aspect-square bg-black">
                    <SeriesThumb series={s} />
                    <span className="absolute right-1 bottom-0.5 text-[10px] font-mono text-white/70">{s.count}</span>
                  </div>
                </button>
              )
            })}
            </div>
          </>
        )}

        {/* viewports */}
        <div className={`flex-1 min-w-0 grid gap-px bg-black/60 ${layout === '2x2' ? 'grid-cols-2 grid-rows-2' : 'grid-cols-1 grid-rows-1'}`}>
          {viewports.slice(0, count).map((v, i) => (
            <div key={i} className="relative min-h-0">
              <Viewport
                vp={v}
                series={seriesList[v.seriesIdx]}
                active={count > 1 && activeVp === i}
                tool={tool}
                showOverlay={showOverlay}
                compact={count > 1}
                onActivate={() => setActiveVp(i)}
                onChange={(c) => patch(i, c)}
              />
              {/* top-left patient/study block, exactly where a PACS puts it */}
              {showOverlay && (
                <div
                  className={`absolute left-2.5 top-2 max-w-[62%] pointer-events-none font-mono text-white/70 leading-[1.5] ${
                    count > 1 ? 'text-[8.5px] sm:text-[9.5px]' : 'text-[9px] sm:text-[11px]'
                  }`}
                >
                  <div className="truncate">Patient: {study.patient.name}</div>
                  <div>Patient ID: {study.patient.id}</div>
                  <div className="hidden sm:block">
                    Age/Sex: {study.patient.age}Y / {study.patient.gender === 'M' ? 'male' : study.patient.gender === 'F' ? 'female' : 'other'}
                  </div>
                  <div className="truncate">Study: {study.modality} — {study.bodyPart}</div>
                  <div className="truncate">Series: {seriesList[v.seriesIdx].name}</div>
                  <div className="hidden sm:block">Acquired: {dateTime(study.createdAt)}</div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* slice scrollbar */}
        <div className="w-11 sm:w-8 shrink-0 bg-[#14171c] border-l border-black/50 flex flex-col items-center py-2 gap-2">
          <span className="text-[10px] font-mono text-slate-500">{vp.slice + 1}</span>
          <input
            type="range"
            min="0"
            max={Math.max(0, activeSeries.count - 1)}
            value={vp.slice}
            onChange={(e) => patch(activeVp, { slice: Number(e.target.value) })}
            className="flex-1 accent-sky-500"
            style={{ writingMode: 'vertical-lr' }}
          />
          <span className="text-[10px] font-mono text-slate-500">{activeSeries.count}</span>
        </div>
      </div>

      {/* status strip */}
      <div className="h-9 sm:h-8 shrink-0 bg-[#14171c] border-t border-black/50 flex items-center gap-3 px-3 sm:px-4 text-[11px] text-slate-400 pb-[env(safe-area-inset-bottom)]">
        <span className="text-sky-400 truncate">
          {(TOOLS.find((t) => t.key === tool)?.hint || '').replace('Drag', isTouch() ? 'Swipe' : 'Drag')}
        </span>
        <span className="ml-auto hidden lg:inline">
          {activeSeries.name} · {activeSeries.count} images · {activeSeries.plane}
          {activeSeries.thickness > 0 ? ` · ${activeSeries.thickness} mm` : ''}
        </span>
        <button onClick={() => setShowShortcuts(true)} className="hover:text-white transition shrink-0 hidden sm:inline">
          Shortcuts (?)
        </button>
        <span className="text-slate-600 shrink-0 hidden xl:inline">Reference rendering — not for diagnostic use</span>
      </div>

      {showShortcuts && (
        <div className="fixed inset-0 z-50 grid place-items-center p-6" onClick={() => setShowShortcuts(false)}>
          <div className="absolute inset-0 bg-black/70" />
          <div className="relative w-full max-w-md rounded-2xl bg-[#181c22] border border-white/10 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[15px] font-semibold text-white">Keyboard &amp; mouse</h3>
              <button onClick={() => setShowShortcuts(false)} className="text-slate-400 hover:text-white">
                <I.X size={16} />
              </button>
            </div>
            <dl className="space-y-2">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="flex items-center gap-4 text-[13px]">
                  <dt className="w-28 shrink-0">
                    <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[11.5px] font-mono text-slate-200">{k}</kbd>
                  </dt>
                  <dd className="text-slate-400">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}
