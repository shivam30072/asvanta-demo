import { useEffect, useRef } from 'react'
import { sliceData, windowInto } from './synth'

const T = 96

export default function SeriesThumb({ series }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(T, T)
    const mid = Math.floor(series.count / 2)
    const buf = sliceData(series.anatomy, series.seed, mid, series.count, T, series.mri)
    windowInto(img, buf, series.ww, series.wc, false)
    ctx.putImageData(img, 0, 0)
  }, [series])

  return <canvas ref={ref} width={T} height={T} className="h-full w-full object-cover" />
}
