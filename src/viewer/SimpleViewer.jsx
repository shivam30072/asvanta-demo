import { useEffect, useRef, useState } from 'react'
import { windowInto } from './synth'
import { seriesSlice } from './series'
import { useVolume } from './useVolume'
import { autoWindow } from './Viewport'
import * as I from '../components/Icons'

const N = 384

/**
 * Cut-down viewer for the patient: scroll through a series, zoom, nothing else.
 * Deliberately not the diagnostic viewer — no windowing, no measurement.
 */
export default function SimpleViewer({ study, series, onClose }) {
  const [idx, setIdx] = useState(Math.floor(series.count / 2))
  const [zoom, setZoom] = useState(1)
  const ref = useRef(null)
  const { vol, progress } = useVolume(series.dicomweb ? series : null)
  const count = vol ? vol.dims[2] : series.count

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || (series.dicomweb && !vol)) return
    const ctx = canvas.getContext('2d')
    const { buf, n, w = n, h = n } = seriesSlice(series, Math.min(idx, count - 1), N)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const img = ctx.createImageData(w, h)
    const win = vol ? autoWindow(vol) : { ww: series.ww, wc: series.wc }
    windowInto(img, buf, win.ww, win.wc, Boolean(vol?.monochrome1))
    ctx.putImageData(img, 0, 0)
  }, [idx, series, vol, count])

  useEffect(() => {
    if (idx > count - 1) setIdx(Math.max(0, count - 1))
  }, [count]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setIdx((i) => Math.min(count - 1, i + 1))
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose, count])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-sm animate-fade-in">
      <div className="h-14 shrink-0 flex items-center gap-4 px-5 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-white truncate">
            {study.modality} — {study.bodyPart}
          </p>
          <p className="text-[11.5px] text-slate-400">{series.name} · {series.dicomweb && !vol ? `loading ${Math.round(progress * 100)}%` : `image ${idx + 1} of ${count}`}</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setZoom((z) => Math.max(1, z - 0.25))} className="h-9 w-9 rounded-lg grid place-items-center text-slate-300 hover:bg-white/10" title="Zoom out">−</button>
          <span className="text-[12px] text-slate-400 w-12 text-center">{zoom.toFixed(2)}x</span>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))} className="h-9 w-9 rounded-lg grid place-items-center text-slate-300 hover:bg-white/10" title="Zoom in">+</button>
          <button onClick={onClose} className="h-9 w-9 rounded-lg grid place-items-center text-slate-300 hover:bg-white/10 ml-2">
            <I.X size={17} />
          </button>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 grid place-items-center overflow-hidden p-4"
        onWheel={(e) => setIdx((i) => Math.max(0, Math.min(count - 1, i + (e.deltaY > 0 ? 1 : -1))))}
      >
        <canvas
          ref={ref}
          width={N}
          height={N}
          className="max-h-full rounded-lg transition-transform"
          style={{ transform: `scale(${zoom})`, imageRendering: 'auto' }}
        />
      </div>

      <div className="shrink-0 px-6 py-4 border-t border-white/10 flex items-center gap-4">
        <button onClick={() => setIdx((i) => Math.max(0, i - 1))} className="h-9 w-9 rounded-lg grid place-items-center text-slate-300 hover:bg-white/10">
          <I.ArrowLeft size={17} />
        </button>
        <input
          type="range"
          min="0"
          max={count - 1}
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          className="flex-1 accent-sky-500"
        />
        <button onClick={() => setIdx((i) => Math.min(count - 1, i + 1))} className="h-9 w-9 rounded-lg grid place-items-center text-slate-300 hover:bg-white/10">
          <I.ArrowRight size={17} />
        </button>
      </div>
      <p className="text-center text-[11.5px] text-slate-500 pb-3">
        Scroll or drag the slider to move through the images. For your own reference — your report is the clinical record.
      </p>
    </div>
  )
}
