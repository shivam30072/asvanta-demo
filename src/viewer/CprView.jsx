import { useMemo, useState } from 'react'
import PlaneView from './PlaneView'
import { Progress } from './MprView'
import { useVolume } from './useVolume'
import { crossSection, lumenArea, planeToWorld, projectToPlane, reslice, straightenedCpr } from '../imaging/volume'
import { sampleCurve } from '../imaging/phantom'
import { diameterProfile, proposedPath, stenosisEstimate } from '../imaging/cpr'
import { dateTime } from '../lib/format'

/** Each reconstructable vessel is a path from its ostium; LAD and LCX start in the left main. */
export const CPR_VESSELS = [
  { key: 'LAD', label: 'LM → LAD', color: '#38bdf8' },
  { key: 'LCX', label: 'LM → LCX', color: '#fbbf24' },
  { key: 'RCA', label: 'RCA', color: '#fb7185' },
]

export default function CprView({ series, tool, win, setWin, showOverlay, verification, onVerify }) {
  const { vol, progress } = useVolume(series)
  if (!series) {
    return (
      <div className="h-full grid place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-[14px] font-semibold text-white">Curved reconstruction needs a contrast vascular series</p>
          <p className="text-[12.5px] text-slate-400 mt-1.5">
            CPR follows the contrast-filled lumen along a vessel centerline. Open the cardiac CT demo study (coronary CTA series) to use it.
          </p>
        </div>
      </div>
    )
  }
  if (!vol) return <Progress value={progress} label="Building 3D volume for curved reconstruction…" />
  return <Cpr series={series} vol={vol} tool={tool} win={win} setWin={setWin} showOverlay={showOverlay} verification={verification} onVerify={onVerify} />
}

function Cpr({ vol, tool, win, setWin, showOverlay, verification = {}, onVerify }) {
  const [vessel, setVessel] = useState('LAD')
  const [paths, setPaths] = useState(() => Object.fromEntries(CPR_VESSELS.map((v) => [v.key, proposedPath(v.key)])))
  const [edited, setEdited] = useState({})
  const [angle, setAngle] = useState(0)
  const [row, setRow] = useState(null)
  const [views, setViews] = useState({ ax: fresh(), cor: fresh(), cpr: fresh(), xs: { zoom: 1, panX: 0, panY: 0 } })
  const [measures, setMeasures] = useState([])
  const [dragIdx, setDragIdx] = useState(null)
  const [active, setActive] = useState('cpr')

  const points = paths[vessel]
  const meta = CPR_VESSELS.find((v) => v.key === vessel)
  const samples = useMemo(() => sampleCurve(points, 0.3), [points])
  const cpr = useMemo(() => straightenedCpr(vol, samples, { angle }), [vol, samples, angle])
  const cursorRow = row == null ? Math.floor(cpr.h * 0.3) : Math.min(cpr.h - 1, row)
  const xsRow = cpr.rows[cursorRow]
  const xs = useMemo(() => crossSection(vol, xsRow), [vol, xsRow])
  const lumen = useMemo(() => lumenArea(xs), [xs])

  const profile = useMemo(() => diameterProfile(vol, cpr.rows), [vol, cpr])
  const sten = useMemo(() => stenosisEstimate(profile), [profile])

  // overview slabs centred on the vessel, thick enough to contain all of it; sized
  // from the proposed path so dragging a point does not re-render the slabs
  const bounds = useMemo(() => {
    const pts = proposedPath(vessel)
    const lo = [0, 1, 2].map((d) => Math.min(...pts.map((p) => p[d])))
    const hi = [0, 1, 2].map((d) => Math.max(...pts.map((p) => p[d])))
    return { lo, hi, mid: lo.map((v, d) => (v + hi[d]) / 2) }
  }, [vessel])
  const ax = useMemo(() => reslice(vol, 'axial', [0, 0, bounds.mid[2]], { slabMm: Math.min(70, bounds.hi[2] - bounds.lo[2] + 8) }), [vol, bounds])
  const cor = useMemo(() => reslice(vol, 'coronal', [0, bounds.mid[1], 0], { slabMm: Math.min(70, bounds.hi[1] - bounds.lo[1] + 8) }), [vol, bounds])

  const status = verification[vessel]
  const verifiedCurrent = status && !edited[vessel]

  const movePoint = (img, axes) => (pt, phase) => {
    if (phase === 'down') {
      let best = null
      points.forEach((p, i) => {
        const q = projectToPlane(img, p)
        const d = Math.hypot((q.c - pt.c) * img.mmX, (q.r - pt.r) * img.mmY)
        if (d < 6 && (!best || d < best.d)) best = { i, d }
      })
      setDragIdx(best ? best.i : null)
      return
    }
    if (phase === 'up') return setDragIdx(null)
    if (dragIdx == null) return
    const w = planeToWorld(img, pt.c, pt.r)
    setPaths((ps) => ({
      ...ps,
      [vessel]: ps[vessel].map((p, i) => (i === dragIdx ? p.map((v, d) => (axes.includes(d) ? w[d] : v)) : p)),
    }))
    setEdited((e) => ({ ...e, [vessel]: true }))
  }

  const drawPath = (img) => (ctx, toScreen) => {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = meta.color
    ctx.beginPath()
    samples.forEach((s, i) => {
      const q = projectToPlane(img, s)
      const [x, y] = toScreen(q.c, q.r)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.stroke()
    points.forEach((p, i) => {
      const q = projectToPlane(img, p)
      const [x, y] = toScreen(q.c, q.r)
      ctx.fillStyle = i === dragIdx ? '#fff' : meta.color
      ctx.beginPath()
      ctx.arc(x, y, i === dragIdx ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fill()
    })
    const q = projectToPlane(img, xsRow.p)
    const [x, y] = toScreen(q.c, q.r)
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.stroke()
  }

  const drawCprCursor = (ctx, toScreen) => {
    const [x1, y] = toScreen(-0.5, cursorRow)
    const [x2] = toScreen(cpr.w - 0.5, cursorRow)
    ctx.strokeStyle = '#fff'
    ctx.globalAlpha = 0.7
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(x1, y)
    ctx.lineTo(x2, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    if (sten && sten.percent >= 25) {
      const r = sten.at / cpr.mmY
      const [, ys] = toScreen(0, r)
      const [xr] = toScreen(cpr.w - 0.5, r)
      ctx.fillStyle = '#f97316'
      ctx.font = '600 11px ui-monospace, monospace'
      ctx.fillText(`◀ ${Math.round(sten.percent)}%`, xr + 4, ys + 4)
    }
  }

  const editTool = tool === 'crosshair' ? 'point' : tool
  const viewProps = (key) => ({
    view: views[key],
    onView: (c) => setViews((v) => ({ ...v, [key]: { ...v[key], ...c } })),
    onWin: setWin,
    win,
    active: active === key,
    onActivate: () => setActive(key),
  })

  return (
    <div className="h-full w-full overflow-y-auto lg:overflow-hidden grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_300px] gap-px bg-black/60">
      {/* overviews: drag the centerline control points */}
      <div className="grid grid-rows-2 gap-px min-h-[70vh] lg:min-h-0">
        {[
          { key: 'ax', img: ax, axes: [0, 1], label: 'Axial MIP' },
          { key: 'cor', img: cor, axes: [0, 2], label: 'Coronal MIP' },
        ].map((o) => (
          <div key={o.key} className="relative min-h-0">
            <PlaneView {...viewProps(o.key)} img={o.img} tool={editTool} onPoint={movePoint(o.img, o.axes)} drawOverlay={drawPath(o.img)}>
              {showOverlay && (
                <div className="absolute left-2 top-1.5 pointer-events-none font-mono text-[10.5px] leading-[1.5]">
                  <div className="text-white/80 font-semibold">{o.label}</div>
                  <div className="text-white/50">Drag the dots to correct the centerline</div>
                </div>
              )}
            </PlaneView>
          </div>
        ))}
      </div>

      {/* straightened CPR */}
      <div className="relative min-h-[70vh] lg:min-h-0">
        <PlaneView
          {...viewProps('cpr')}
          img={cpr}
          tool={editTool}
          onPoint={(pt) => setRow(Math.max(0, Math.min(cpr.h - 1, Math.round(pt.r))))}
          onScroll={(d) => setRow(Math.max(0, Math.min(cpr.h - 1, cursorRow + d * 2)))}
          measurements={measures}
          onMeasurements={setMeasures}
          drawOverlay={drawCprCursor}
        >
          {showOverlay && (
            <div className="absolute left-2 top-1.5 pointer-events-none font-mono text-[10.5px] sm:text-[11px] leading-[1.5]">
              <div className="font-semibold" style={{ color: meta.color }}>Curved MPR · {meta.label}</div>
              <div className="text-white/60">Length {cpr.length.toFixed(1)} mm · rotation {angle}°</div>
              <div className="text-white/60">Cursor at {xsRow.s.toFixed(1)} mm from ostium</div>
            </div>
          )}
          <div className="absolute right-2 top-1.5 rounded-md bg-black/60 px-2 py-1.5 text-[10px] text-slate-300" onPointerDown={(e) => e.stopPropagation()}>
            <label className="flex items-center gap-1.5">
              <span>Rotate</span>
              <input type="range" min="0" max="179" value={angle} onChange={(e) => setAngle(Number(e.target.value))} className="w-24 accent-sky-400" />
            </label>
          </div>
        </PlaneView>
      </div>

      {/* vessel, cross-section, measurements, verification */}
      <div className="bg-[#14171c] overflow-y-auto p-3.5 space-y-3.5 text-[12.5px]">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500 mb-1.5">Vessel</p>
          <div className="grid grid-cols-3 gap-1">
            {CPR_VESSELS.map((v) => (
              <button
                key={v.key}
                onClick={() => {
                  setVessel(v.key)
                  setRow(null)
                  setMeasures([])
                }}
                className={`rounded-md py-1.5 text-[11.5px] font-medium transition ${vessel === v.key ? 'bg-white/15 text-white' : 'text-slate-400 hover:bg-white/5'}`}
              >
                <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: v.color }} />
                {v.key}
              </button>
            ))}
          </div>
        </div>

        <div className="aspect-square relative rounded-md overflow-hidden">
          <PlaneView {...viewProps('xs')} img={xs} tool={tool === 'crosshair' ? 'zoom' : tool}>
            <div className="absolute left-1.5 top-1 pointer-events-none font-mono text-[10px] text-white/70">Cross-section ⟂ vessel</div>
          </PlaneView>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11.5px]">
          <dt className="text-slate-500">Lumen area</dt>
          <dd className="text-slate-200 text-right">{lumen.areaMm2.toFixed(1)} mm²</dd>
          <dt className="text-slate-500">Lumen ⌀</dt>
          <dd className="text-slate-200 text-right">{lumen.diameterMm.toFixed(1)} mm</dd>
          <dt className="text-slate-500">Position</dt>
          <dd className="text-slate-200 text-right">{xsRow.s.toFixed(1)} mm</dd>
        </dl>

        <DiameterProfile profile={profile} cursor={xsRow.s} sten={sten} onPick={(s) => setRow(Math.round(s / cpr.mmY))} />

        {sten && (
          <div className={`rounded-lg border p-2.5 ${sten.percent >= 50 ? 'border-orange-500/40 bg-orange-500/10' : 'border-white/10 bg-white/5'}`}>
            <p className="text-[12px] text-slate-200">
              Narrowest lumen <b>{sten.dMin.toFixed(1)} mm</b> at {sten.at.toFixed(0)} mm vs reference {sten.dRef.toFixed(1)} mm
            </p>
            <p className="text-[12px] mt-0.5">
              Estimated diameter stenosis <b className={sten.percent >= 50 ? 'text-orange-300' : 'text-slate-100'}>{Math.round(sten.percent)}%</b>
            </p>
            <button onClick={() => setRow(Math.round(sten.at / cpr.mmY))} className="mt-1.5 text-[11.5px] text-sky-400 hover:text-sky-300">
              Go to narrowest point
            </button>
            <p className="text-[10.5px] text-slate-500 mt-1.5">Automated estimate from lumen thresholding — confirm visually before reporting.</p>
          </div>
        )}

        <div className="rounded-lg border border-white/10 p-2.5 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Centerline</p>
          <p className="text-[12px] text-slate-300">
            {verifiedCurrent ? (
              <span className="text-emerald-400">Verified by {status.by} · {dateTime(status.at)}</span>
            ) : status ? (
              <span className="text-amber-300">Edited after verification — verify again</span>
            ) : edited[vessel] ? (
              <span className="text-amber-300">Edited · not yet verified</span>
            ) : (
              <span className="text-slate-400">Proposed automatically · not verified</span>
            )}
          </p>
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                setPaths((p) => ({ ...p, [vessel]: proposedPath(vessel) }))
                setEdited((e) => ({ ...e, [vessel]: false }))
              }}
              className="flex-1 rounded-md border border-white/15 py-1.5 text-[11.5px] text-slate-300 hover:bg-white/5"
            >
              Reset
            </button>
            <button
              onClick={() => {
                onVerify?.(vessel, { points, edited: Boolean(edited[vessel]), stenosis: sten ? Math.round(sten.percent) : null })
                setEdited((e) => ({ ...e, [vessel]: false }))
              }}
              disabled={verifiedCurrent}
              className="flex-1 rounded-md bg-emerald-600 py-1.5 text-[11.5px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Mark verified
            </button>
          </div>
        </div>
        <p className="text-[10.5px] text-slate-500 leading-relaxed">
          Use <b>Point</b> to drag centerline dots or pick a position on the CPR. <b>Measure</b> on the CPR gives length along the vessel.
        </p>
      </div>
    </div>
  )
}

const fresh = () => ({ zoom: 1, panX: 0, panY: 0 })

function DiameterProfile({ profile, cursor, sten, onPick }) {
  if (profile.length < 2) return null
  const W = 270
  const H = 70
  const total = profile[profile.length - 1].s || 1
  const maxD = Math.max(4, ...profile.map((p) => p.d))
  const X = (s) => (s / total) * W
  const Y = (d) => H - 4 - (d / maxD) * (H - 10)
  const path = profile.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)},${Y(p.d).toFixed(1)}`).join(' ')
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500 mb-1">Lumen diameter along vessel</p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[70px] cursor-pointer"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onPick(((e.clientX - r.left) / r.width) * total)
        }}
      >
        <path d={path} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
        {sten && <circle cx={X(sten.at)} cy={Y(sten.dMin)} r="3" fill="#f97316" />}
        <line x1={X(cursor)} x2={X(cursor)} y1="0" y2={H} stroke="#fff" strokeOpacity="0.5" strokeDasharray="3 3" />
      </svg>
      <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span>ostium</span>
        <span>{total.toFixed(0)} mm</span>
      </div>
    </div>
  )
}
