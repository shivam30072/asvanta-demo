/**
 * Vessel analysis on a curved reconstruction: proposed paths, lumen diameter
 * profile and an automated stenosis hint. The radiologist verifies all of it.
 */
import { proposedCenterline } from './phantom'
import { crossSection, lumenArea } from './volume'

/** Each reconstructable vessel is a path from its ostium; LAD and LCX start in the left main. */
export const proposedPath = (vessel) =>
  vessel === 'RCA' ? proposedCenterline('RCA') : [...proposedCenterline('LM'), ...proposedCenterline(vessel).slice(1)]

/** Lumen diameter every other CPR row. */
export function diameterProfile(vol, rows) {
  const out = []
  for (let r = 0; r < rows.length; r += 2) {
    // 150 HU floor: a tight stenosis blurs its contrast column well below the 200 HU used for a single cross-section
    const l = lumenArea(crossSection(vol, rows[r], { halfWidthMm: 5, step: 0.25 }), { lo: 150 })
    out.push({ s: rows[r].s, d: l.diameterMm })
  }
  return out
}

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/**
 * Diameter stenosis estimate: at each point, lumen diameter against the median of
 * the segments 4–12 mm either side; report the worst. Comparing with the local
 * reference keeps normal distal tapering from reading as disease.
 * An automated hint for the radiologist, not a result.
 */
const OSTIUM_MM = 10

export function stenosisEstimate(profile) {
  if (profile.length < 10) return null
  const total = profile[profile.length - 1].s
  const near = (lo, hi) => profile.filter((p) => p.s >= lo && p.s <= hi && p.d > 0).map((p) => p.d)
  let worst = null
  for (const p of profile) {
    // skip the ostium, where the lumen runs into the aortic blood pool, and the very end
    if (p.s < OSTIUM_MM || p.s > total - 4) continue
    const refs = [median(near(p.s - 12, p.s - 4)), median(near(p.s + 4, p.s + 12))].filter(Boolean)
    if (!refs.length) continue
    const ref = refs.reduce((a, b) => a + b, 0) / refs.length
    const percent = Math.max(0, 1 - p.d / ref) * 100
    if (!worst || percent > worst.percent) worst = { at: p.s, dMin: p.d, dRef: ref, percent }
  }
  return worst
}

