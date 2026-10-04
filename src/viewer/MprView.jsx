import { useMemo, useState } from 'react'
import PlaneView from './PlaneView'
import { useVolume } from './useVolume'
import { extent, projectToPlane, reslice, planeToWorld } from '../imaging/volume'

const PLANES = [
  { key: 'axial', label: 'Axial', color: '#38bdf8', ring: 'ring-sky-400/80', marks: ['A', 'P', 'R', 'L'] },
  { key: 'coronal', label: 'Coronal', color: '#34d399', ring: 'ring-emerald-400/80', marks: ['S', 'I', 'R', 'L'] },
  { key: 'sagittal', label: 'Sagittal', color: '#fbbf24', ring: 'ring-amber-400/80', marks: ['S', 'I', 'A', 'P'] },
  { key: 'oblique', label: 'Oblique', color: '#e879f9', ring: 'ring-fuchsia-400/80', marks: ['', '', '', ''] },
]

const freshView = () => ({ zoom: 1, panX: 0, panY: 0 })

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Where to put the crosshair when the volume first opens: on the heart for cardiac studies. */
const startPoint = (series, vol) => {
  const ex = extent(vol)
  if (series.phantom) return [140, 112, Math.min(ex.z[1], Math.max(ex.z[0], 80))]
  return [(ex.x[0] + ex.x[1]) / 2, (ex.y[0] + ex.y[1]) / 2, (ex.z[0] + ex.z[1]) / 2]
}

export function Progress({ value, label }) {
  return (
    <div className="h-full w-full grid place-items-center bg-black">
      <div className="w-64 text-center">
        <p className="text-[12.5px] text-slate-300 mb-2">{label}</p>
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />
        </div>
        <p className="text-[11px] text-slate-500 mt-2 font-mono">{Math.round(value * 100)}%</p>
      </div>
    </div>
  )
}

/**
 * Multiplanar reconstruction: axial, coronal, sagittal and a free oblique plane
 * through a shared crosshair, all resliced from one 3D volume.
 */
export default function MprView({ series, tool, win, setWin, showOverlay, slabMm }) {
  const { vol, progress } = useVolume(series)
  if (!vol) return <Progress value={progress} label={`Building 3D volume from ${series.count} slices…`} />
  return <Mpr key={series.id} series={series} vol={vol} tool={tool} win={win} setWin={setWin} showOverlay={showOverlay} slabMm={slabMm} />
}

function Mpr({ series, vol, tool, win, setWin, showOverlay, slabMm }) {
  const ex = useMemo(() => extent(vol), [vol])
  const [cursor, setCursor] = useState(() => startPoint(series, vol))
  const [views, setViews] = useState(() => Object.fromEntries(PLANES.map((p) => [p.key, freshView()])))
  const [active, setActive] = useState('axial')
  const [angle, setAngle] = useState(35)
  const [tilt, setTilt] = useState(0)
  const [measures, setMeasures] = useState({ axial: [], coronal: [], sagittal: [], oblique: [] })

  const [x, y, z] = cursor
  const slab = { slabMm }
  // each plane only recomputes when the coordinate it depends on moves
  const axial = useMemo(() => reslice(vol, 'axial', [0, 0, z], slab), [vol, z, slabMm]) // eslint-disable-line react-hooks/exhaustive-deps
  const coronal = useMemo(() => reslice(vol, 'coronal', [0, y, 0], slab), [vol, y, slabMm]) // eslint-disable-line react-hooks/exhaustive-deps
  const sagittal = useMemo(() => reslice(vol, 'sagittal', [x, 0, 0], slab), [vol, x, slabMm]) // eslint-disable-line react-hooks/exhaustive-deps
  const oblique = useMemo(() => reslice(vol, 'oblique', cursor, { angle, tilt, slabMm }), [vol, cursor, angle, tilt, slabMm])
  const images = { axial, coronal, sagittal, oblique }

  const clamp = (p) => [
    Math.max(ex.x[0], Math.min(ex.x[1], p[0])),
    Math.max(ex.y[0], Math.min(ex.y[1], p[1])),
    Math.max(ex.z[0], Math.min(ex.z[1], p[2])),
  ]

  const step = { axial: vol.spacing[2], coronal: vol.spacing[1], sagittal: vol.spacing[0], oblique: Math.min(...vol.spacing) }
  const scroll = (plane, dir) => {
    const n = images[plane].normal
    const d = step[plane] * dir
    // keep axial/coronal/sagittal moves on the voxel grid
    setCursor((c) => clamp(c.map((v, i) => v + Math.sign(n[i]) * Math.abs(n[i]) * d)))
  }

  const posKey = (plane) => {
    const n = images[plane].normal
    return Math.round((cursor[0] * n[0] + cursor[1] * n[1] + cursor[2] * n[2]) * 10) / 10
  }

  const overlay = (plane) => (ctx, toScreen) => {
    const img = images[plane]
    for (const other of PLANES) {
      if (other.key === plane) continue
      const dir = cross(img.normal, images[other.key].normal)
      if (Math.hypot(...dir) < 1e-6) continue
      const a = projectToPlane(img, cursor.map((v, i) => v - dir[i] * 2000))
      const b = projectToPlane(img, cursor.map((v, i) => v + dir[i] * 2000))
      const [x1, y1] = toScreen(a.c, a.r)
      const [x2, y2] = toScreen(b.c, b.r)
      ctx.strokeStyle = other.color
      ctx.globalAlpha = 0.75
      ctx.lineWidth = 1
      ctx.setLineDash(other.key === 'oblique' ? [5, 4] : [])
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    const c = projectToPlane(img, cursor)
    const [cx, cy] = toScreen(c.c, c.r)
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI * 2)
    ctx.stroke()
  }

  const position = (plane) => {
    if (plane === 'axial') return `Z ${z.toFixed(1)} mm · ${Math.round((z - vol.z0) / vol.spacing[2]) + 1}/${vol.dims[2]}`
    if (plane === 'coronal') return `Y ${y.toFixed(1)} mm`
    if (plane === 'sagittal') return `X ${x.toFixed(1)} mm`
    return `${angle}° · tilt ${tilt}°`
  }

  const huAtCursor = useMemo(() => {
    const k = Math.round((z - vol.z0) / vol.spacing[2])
    const i = Math.round(x / vol.spacing[0] - 0.5)
    const j = Math.round(y / vol.spacing[1] - 0.5)
    return vol.hu[k * vol.dims[0] * vol.dims[1] + j * vol.dims[0] + i]
  }, [vol, x, y, z])

  return (
    <div className="h-full w-full grid grid-cols-2 grid-rows-2 gap-px bg-black/60">
      {PLANES.map((p) => {
        const key = posKey(p.key)
        const list = measures[p.key].filter((m) => m.key === key)
        return (
          <div key={p.key} className="relative min-h-0 min-w-0">
            <PlaneView
              img={images[p.key]}
              win={win}
              view={views[p.key]}
              onView={(c) => setViews((v) => ({ ...v, [p.key]: { ...v[p.key], ...c } }))}
              onWin={setWin}
              tool={tool === 'crosshair' ? 'point' : tool}
              onScroll={(dir) => scroll(p.key, dir)}
              onPoint={(pt) => setCursor(clamp(planeToWorld(images[p.key], pt.c, pt.r)))}
              measurements={list}
              onMeasurements={(next) =>
                setMeasures((m) => ({ ...m, [p.key]: [...m[p.key].filter((x2) => x2.key !== key), ...next.map((n) => ({ ...n, key }))] }))
              }
              drawOverlay={overlay(p.key)}
              active={active === p.key}
              onActivate={() => setActive(p.key)}
              ring={p.ring}
            >
              {showOverlay && (
                <>
                  <div className="absolute left-2 top-1.5 pointer-events-none font-mono text-[10px] sm:text-[11px] leading-[1.5]">
                    <div style={{ color: p.color }} className="font-semibold">{p.label}{slabMm ? ` · MIP ${slabMm} mm` : ''}</div>
                    <div className="text-white/60">{position(p.key)}</div>
                  </div>
                  {p.marks[0] && (
                    <>
                      <span className="absolute left-1/2 top-1 -translate-x-1/2 text-[10px] font-mono text-white/40">{p.marks[0]}</span>
                      <span className="absolute left-1/2 bottom-1 -translate-x-1/2 text-[10px] font-mono text-white/40">{p.marks[1]}</span>
                      <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] font-mono text-white/40">{p.marks[2]}</span>
                      <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] font-mono text-white/40">{p.marks[3]}</span>
                    </>
                  )}
                  {p.key === 'axial' && (
                    <div className="absolute right-2 bottom-1.5 pointer-events-none font-mono text-[10px] sm:text-[11px] text-white/60 text-right leading-[1.5]">
                      <div>Cursor {x.toFixed(0)}, {y.toFixed(0)}, {z.toFixed(0)} mm</div>
                      <div>{Math.round(huAtCursor)} HU</div>
                    </div>
                  )}
                </>
              )}
              {p.key === 'oblique' && (
                <div
                  className="absolute right-2 top-1.5 flex flex-col gap-1 rounded-md bg-black/60 px-2 py-1.5 text-[10px] text-slate-300"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <label className="flex items-center gap-1.5">
                    <span className="w-8">Angle</span>
                    <input type="range" min="-90" max="90" value={angle} onChange={(e) => setAngle(Number(e.target.value))} className="w-20 sm:w-24 accent-fuchsia-400" />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="w-8">Tilt</span>
                    <input type="range" min="-60" max="60" value={tilt} onChange={(e) => setTilt(Number(e.target.value))} className="w-20 sm:w-24 accent-fuchsia-400" />
                  </label>
                </div>
              )}
            </PlaneView>
          </div>
        )
      })}
    </div>
  )
}
