import { useEffect, useRef, useState } from 'react'
import { fetchThumbnail, middleInstance } from '../live/dicomweb'
import { windowInto } from './synth'
import { seriesSlice } from './series'

const T = 96

const downsample = (buf, n, t) => {
  const out = new Float32Array(t * t)
  for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) out[j * t + i] = buf[Math.floor((j * n) / t) * n + Math.floor((i * n) / t)]
  return out
}

/** PACS series: the PACS renders the middle image as a JPEG. */
function PacsThumb({ series }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    middleInstance(series.dicomweb)
      .then((sop) => fetchThumbnail(series.dicomweb, sop))
      .then((u) => {
        made = u
        if (live) setUrl(u)
      })
      .catch(() => {})
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [series])
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-black" />
}

export default function SeriesThumb({ series }) {
  if (series.dicomweb) return <PacsThumb series={series} />
  return <LocalThumb series={series} />
}

function LocalThumb({ series }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(T, T)
    const mid = Math.floor(series.count / 2)
    const { buf, n } = seriesSlice(series, mid, T)
    windowInto(img, n === T ? buf : downsample(buf, n, T), series.ww, series.wc, false)
    ctx.putImageData(img, 0, 0)
  }, [series])

  return <canvas ref={ref} width={T} height={T} className="h-full w-full object-cover" />
}
