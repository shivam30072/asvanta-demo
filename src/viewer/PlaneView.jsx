import { useCallback, useEffect, useRef } from 'react'
import { windowInto } from './synth'

/**
 * Draws one reconstructed image ({ data, w, h, mmX, mmY }) at its true physical
 * aspect and owns pointer interaction. Coordinates handed out (`onPoint`,
 * measurements, `drawOverlay`) are image pixels {c, r}, so callers can map them
 * back to world space through the reslice geometry.
 */
export default function PlaneView({
  img,
  win,
  view,
  onView,
  onWin,
  tool,
  onScroll,
  onPoint,
  measurements = [],
  onMeasurements,
  mask,
  drawOverlay,
  active,
  onActivate,
  children,
  cursor,
  ring = 'ring-sky-500/70',
}) {
  const boxRef = useRef(null)
  const canvasRef = useRef(null)
  const offRef = useRef(null)
  const maskRef = useRef(null)
  const drag = useRef(null)

  const geometry = useCallback(() => {
    const box = boxRef.current
    if (!box || !img) return null
    const bw = box.clientWidth
    const bh = box.clientHeight
    const W = img.w * img.mmX
    const H = img.h * img.mmY
    const s = Math.min(bw / W, bh / H) * 0.94 * view.zoom // screen px per mm
    const x0 = bw / 2 + view.panX - (W * s) / 2
    const y0 = bh / 2 + view.panY - (H * s) / 2
    return { bw, bh, s, x0, y0, W, H }
  }, [img, view])

  const toScreen = useCallback(
    (c, r) => {
      const g = geometry()
      return [g.x0 + (c + 0.5) * img.mmX * g.s, g.y0 + (r + 0.5) * img.mmY * g.s]
    },
    [geometry, img]
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const g = geometry()
    if (!canvas || !g) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(g.bw * dpr) || canvas.height !== Math.round(g.bh * dpr)) {
      canvas.width = Math.round(g.bw * dpr)
      canvas.height = Math.round(g.bh * dpr)
    }
    if (!offRef.current || offRef.current.width !== img.w || offRef.current.height !== img.h) {
      offRef.current = document.createElement('canvas')
      offRef.current.width = img.w
      offRef.current.height = img.h
    }
    const octx = offRef.current.getContext('2d')
    const id = octx.createImageData(img.w, img.h)
    windowInto(id, img.data, win.ww, win.wc, win.invert)
    octx.putImageData(id, 0, 0)

    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, g.bw, g.bh)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(offRef.current, g.x0, g.y0, g.W * g.s, g.H * g.s)

    if (mask) {
      if (!maskRef.current || maskRef.current.width !== img.w || maskRef.current.height !== img.h) {
        maskRef.current = document.createElement('canvas')
        maskRef.current.width = img.w
        maskRef.current.height = img.h
      }
      const mctx = maskRef.current.getContext('2d')
      mctx.putImageData(new ImageData(mask, img.w, img.h), 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(maskRef.current, g.x0, g.y0, g.W * g.s, g.H * g.s)
    }

    if (drawOverlay) drawOverlay(ctx, toScreen, g)

    if (measurements.length) {
      ctx.lineWidth = 1.5
      ctx.font = '600 12px ui-monospace, monospace'
      ctx.strokeStyle = '#38bdf8'
      ctx.fillStyle = '#38bdf8'
      for (const m of measurements) {
        const [x1, y1] = toScreen(m.a.c, m.a.r)
        const [x2, y2] = toScreen(m.b.c, m.b.r)
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
          ctx.beginPath()
          ctx.moveTo(cx - 4, cy)
          ctx.lineTo(cx + 4, cy)
          ctx.moveTo(cx, cy - 4)
          ctx.lineTo(cx, cy + 4)
          ctx.stroke()
        }
        const mm = Math.hypot((m.b.c - m.a.c) * img.mmX, (m.b.r - m.a.r) * img.mmY)
        ctx.fillText(`${mm.toFixed(1)} mm`, (x1 + x2) / 2 + 8, (y1 + y2) / 2 - 6)
      }
    }
  }, [geometry, img, win, mask, drawOverlay, measurements, toScreen])

  useEffect(() => {
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [draw])

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

  const imagePoint = (e) => {
    const g = geometry()
    const rect = boxRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return { c: (x - g.x0) / (img.mmX * g.s) - 0.5, r: (y - g.y0) / (img.mmY * g.s) - 0.5 }
  }

  const onPointerDown = (e) => {
    if (!img) return
    onActivate?.()
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = e.button === 1 ? 'pan' : e.button === 2 ? 'wl' : tool
    const p = imagePoint(e)
    drag.current = { tool: t, x: e.clientX, y: e.clientY, view: { ...view }, win: { ...win }, acc: 0, point: p }
    if (t === 'measure' && onMeasurements) onMeasurements([...measurements, { a: p, b: p }])
    if (t === 'point') onPoint?.(p, 'down', e)
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (d.tool === 'stack') {
      const steps = Math.trunc(dy / 7) - d.acc
      if (steps) {
        d.acc += steps
        for (let i = 0; i < Math.abs(steps); i++) onScroll?.(Math.sign(steps))
      }
    } else if (d.tool === 'zoom') onView({ zoom: Math.max(0.25, Math.min(16, d.view.zoom * (1 - dy / 260))) })
    else if (d.tool === 'pan') onView({ panX: d.view.panX + dx, panY: d.view.panY + dy })
    else if (d.tool === 'wl') onWin({ ww: Math.max(4, d.win.ww + dx * 3), wc: d.win.wc - dy * 3 })
    else if (d.tool === 'measure' && onMeasurements) {
      const last = measurements[measurements.length - 1]
      onMeasurements([...measurements.slice(0, -1), { ...last, b: imagePoint(e) }])
    } else if (d.tool === 'point') onPoint?.(imagePoint(e), 'move', e)
  }

  const onPointerUp = (e) => {
    const d = drag.current
    if (d?.tool === 'measure' && onMeasurements) {
      const last = measurements[measurements.length - 1]
      if (last && Math.hypot((last.b.c - last.a.c) * img.mmX, (last.b.r - last.a.r) * img.mmY) < 1) onMeasurements(measurements.slice(0, -1))
    }
    if (d?.tool === 'point') onPoint?.(imagePoint(e), 'up', e)
    drag.current = null
  }

  const onWheel = (e) => onScroll?.(e.deltaY > 0 ? 1 : -1)

  const cursors = { stack: 'ns-resize', zoom: 'zoom-in', pan: 'grab', wl: 'crosshair', measure: 'crosshair', point: 'crosshair' }

  return (
    <div
      ref={boxRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
      className={`relative h-full w-full bg-black overflow-hidden select-none touch-none ${active ? `ring-1 ring-inset ${ring}` : ''}`}
      style={{ cursor: cursor || cursors[tool] }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {!img && <div className="absolute inset-0 grid place-items-center text-[12px] text-slate-500">Reconstructing…</div>}
      {children}
    </div>
  )
}
