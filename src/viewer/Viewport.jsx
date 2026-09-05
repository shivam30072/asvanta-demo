import { useCallback, useEffect, useRef } from 'react'
import { sliceData, windowInto } from './synth'

const N = 384 // rendered matrix, mirrors a typical reconstructed slice

/**
 * One viewport: draws the slice to a canvas and owns all mouse interaction.
 * Everything it changes is reported upward through `onChange`.
 */
export default function Viewport({ vp, series, active, tool, onChange, onActivate, showOverlay, compact }) {
  const canvasRef = useRef(null)
  const offRef = useRef(null)
  const imgRef = useRef(null)
  const drag = useRef(null)
  const boxRef = useRef(null)

  // one offscreen buffer per viewport, reused every frame
  if (!offRef.current && typeof document !== 'undefined') {
    offRef.current = document.createElement('canvas')
    offRef.current.width = N
    offRef.current.height = N
    imgRef.current = offRef.current.getContext('2d').createImageData(N, N)
  }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const box = boxRef.current
    if (!canvas || !box || !series) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = box.clientWidth
    const h = box.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }

    const buf = sliceData(series.anatomy, series.seed, vp.slice, series.count, N, series.mri)
    windowInto(imgRef.current, buf, vp.ww, vp.wc, vp.invert)
    offRef.current.getContext('2d').putImageData(imgRef.current, 0, 0)

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const fit = Math.min(w, h) * 0.94
    const size = fit * vp.zoom

    ctx.save()
    ctx.translate(w / 2 + vp.panX, h / 2 + vp.panY)
    ctx.rotate((vp.rotate * Math.PI) / 180)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(offRef.current, -size / 2, -size / 2, size, size)
    ctx.restore()

    // measurements sit in image space so they stay glued to the anatomy
    if (vp.measurements.length) {
      const toScreen = (p) => {
        const a = (vp.rotate * Math.PI) / 180
        const x = (p.x - 0.5) * size
        const y = (p.y - 0.5) * size
        return [w / 2 + vp.panX + x * Math.cos(a) - y * Math.sin(a), h / 2 + vp.panY + x * Math.sin(a) + y * Math.cos(a)]
      }
      ctx.lineWidth = 1.5
      ctx.font = '600 12px ui-monospace, monospace'
      vp.measurements.forEach((m) => {
        if (m.slice !== vp.slice) return
        const [x1, y1] = toScreen(m.a)
        const [x2, y2] = toScreen(m.b)
        ctx.strokeStyle = '#38bdf8'
        ctx.fillStyle = '#38bdf8'
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        ;[[x1, y1], [x2, y2]].forEach(([cx, cy]) => {
          ctx.beginPath()
          ctx.moveTo(cx - 4, cy)
          ctx.lineTo(cx + 4, cy)
          ctx.moveTo(cx, cy - 4)
          ctx.lineTo(cx, cy + 4)
          ctx.stroke()
        })
        const mm = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) * N * series.pixelSpacing
        ctx.fillText(`${mm.toFixed(1)} mm`, (x1 + x2) / 2 + 8, (y1 + y2) / 2 - 6)
      })
    }
  }, [vp, series])

  useEffect(() => {
    draw()
  }, [draw])

  // A layout switch resizes every viewport. Redraw on the next frame, once the
  // grid has actually laid out — reading clientWidth mid-transition leaves a
  // canvas sized to the old cell and the image ends up clipped.
  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw, compact])

  useEffect(() => {
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    })
    if (boxRef.current) ro.observe(boxRef.current)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [draw])

  /* -------------------------------------------------- pointer interaction */

  const imagePoint = (e) => {
    const box = boxRef.current.getBoundingClientRect()
    const fit = Math.min(box.width, box.height) * 0.94
    const size = fit * vp.zoom
    const dx = e.clientX - box.left - box.width / 2 - vp.panX
    const dy = e.clientY - box.top - box.height / 2 - vp.panY
    const a = (-vp.rotate * Math.PI) / 180
    return { x: (dx * Math.cos(a) - dy * Math.sin(a)) / size + 0.5, y: (dx * Math.sin(a) + dy * Math.cos(a)) / size + 0.5 }
  }

  const onPointerDown = (e) => {
    onActivate()
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = e.button === 1 ? 'pan' : e.button === 2 ? 'wl' : tool
    drag.current = { tool: t, x: e.clientX, y: e.clientY, start: { ...vp }, point: imagePoint(e) }
    if (t === 'measure') {
      const p = drag.current.point
      onChange({ measurements: [...vp.measurements, { a: p, b: p, slice: vp.slice }] })
    }
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y

    if (d.tool === 'stack') {
      const next = Math.max(0, Math.min(series.count - 1, d.start.slice + Math.round(dy / 6)))
      if (next !== vp.slice) onChange({ slice: next })
    } else if (d.tool === 'zoom') {
      onChange({ zoom: Math.max(0.25, Math.min(12, d.start.zoom * (1 - dy / 260))) })
    } else if (d.tool === 'pan') {
      onChange({ panX: d.start.panX + dx, panY: d.start.panY + dy })
    } else if (d.tool === 'wl') {
      onChange({ ww: Math.max(4, d.start.ww + dx * 3), wc: d.start.wc - dy * 3 })
    } else if (d.tool === 'measure') {
      const rest = vp.measurements.slice(0, -1)
      const last = vp.measurements[vp.measurements.length - 1]
      onChange({ measurements: [...rest, { ...last, b: imagePoint(e) }] })
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    if (d?.tool === 'measure') {
      const last = vp.measurements[vp.measurements.length - 1]
      // discard accidental taps that never became a line
      if (last && Math.hypot(last.b.x - last.a.x, last.b.y - last.a.y) < 0.01) {
        onChange({ measurements: vp.measurements.slice(0, -1) })
      }
    }
    drag.current = null
  }

  const onWheel = (e) => {
    if (!series) return
    const dir = e.deltaY > 0 ? 1 : -1
    const next = Math.max(0, Math.min(series.count - 1, vp.slice + dir))
    if (next !== vp.slice) onChange({ slice: next })
  }

  const cursor = { stack: 'ns-resize', zoom: 'zoom-in', pan: 'grab', wl: 'crosshair', measure: 'crosshair' }[tool]

  if (!series) return <div className="h-full w-full bg-black" />

  const mmPerPx = series.pixelSpacing
  const label = compact ? 'text-[8.5px] sm:text-[9.5px]' : 'text-[9px] sm:text-[11px]'

  return (
    <div
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      className={`relative h-full w-full bg-black overflow-hidden select-none touch-none ${active ? 'ring-1 ring-inset ring-sky-500/70' : ''}`}
      style={{ cursor }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {showOverlay && (
        <>
          {/* orientation markers */}
          <span className={`absolute left-1/2 top-1.5 -translate-x-1/2 ${label} font-mono text-white/45`}>
            {vp.plane === 'Sag' ? 'S' : 'A'}
          </span>
          <span className={`absolute left-1/2 bottom-1.5 -translate-x-1/2 ${label} font-mono text-white/45`}>
            {vp.plane === 'Sag' ? 'I' : 'P'}
          </span>
          <span className={`absolute left-1.5 top-1/2 -translate-y-1/2 ${label} font-mono text-white/45`}>R</span>
          <span className={`absolute right-1.5 top-1/2 -translate-y-1/2 ${label} font-mono text-white/45`}>L</span>

          {/* bottom-left: acquisition detail */}
          <div className={`absolute left-2.5 bottom-2 ${label} font-mono text-white/60 leading-[1.5] pointer-events-none`}>
            <div>Dimensions: {N} x {N}</div>
            {series.thickness > 0 && <div className="hidden sm:block">Slice Thickness: {series.thickness} mm</div>}
            <div>
              Im: {vp.slice + 1}/{series.count} <span className="text-sky-400/80">({series.plane === 'Sag' ? 'R → L' : 'S → I'})</span>
            </div>
            <div className="hidden sm:block">Instance Number: {vp.slice + 1}</div>
            <div className="hidden sm:block">Series Number: {series.number}</div>
          </div>

          {/* bottom-right: display state */}
          <div className={`absolute right-2.5 bottom-2 ${label} font-mono text-white/60 leading-[1.5] text-right pointer-events-none`}>
            <div>Zoom Scale: {vp.zoom.toFixed(2)}x</div>
            <div className="hidden sm:block">Pan - X Axis: {Math.round(vp.panX)}</div>
            <div className="hidden sm:block">Pan - Y Axis: {Math.round(vp.panY)}</div>
            <div>WL: {Math.round(vp.wc)}</div>
            <div>WW: {Math.round(vp.ww)}</div>
          </div>

          <div className={`absolute right-2.5 top-2 ${label} font-mono text-white/45 pointer-events-none hidden sm:block`}>
            {mmPerPx} mm/px
          </div>
        </>
      )}
    </div>
  )
}
