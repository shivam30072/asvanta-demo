import { useEffect, useState } from 'react'
import { cachedVolume, loadVolume } from '../imaging/volume'

/** The 3D volume for a series, built in the background. `progress` runs 0 → 1. */
export function useVolume(series) {
  const [state, setState] = useState(() => ({ vol: series ? cachedVolume(series) : null, progress: 0, id: series?.id }))

  useEffect(() => {
    if (!series) return
    const hit = cachedVolume(series)
    if (hit) {
      setState({ vol: hit, progress: 1, id: series.id })
      return
    }
    let live = true
    setState({ vol: null, progress: 0, id: series.id })
    loadVolume(series, (p) => live && setState((s) => (s.id === series.id ? { ...s, progress: p } : s))).then(
      (vol) => live && setState({ vol, progress: 1, id: series.id })
    )
    return () => {
      live = false
    }
  }, [series])

  return state.id === series?.id ? state : { vol: null, progress: 0 }
}
