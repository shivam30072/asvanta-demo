import { describe, expect, it } from 'vitest'
import { CARDIAC_SERIES, CENTERLINES, sampleCurve } from './phantom'
import { loadVolume, straightenedCpr } from './volume'
import { diameterProfile, proposedPath, stenosisEstimate } from './cpr'

describe('curved reconstruction on the contrast phantom', () => {
  it('finds the planted LAD stenosis along the true centerline', async () => {
    const vol = await loadVolume({ id: 'test-cta', phantom: CARDIAC_SERIES[1] })
    const path = [...CENTERLINES.LM, ...CENTERLINES.LAD.slice(1)]
    const cpr = straightenedCpr(vol, sampleCurve(path, 0.3))
    const lmLength = cpr.rows.find((r, i) => i > 0 && Math.hypot(...r.p.map((v, d) => v - CENTERLINES.LM[2][d])) < 0.5)?.s ?? 15
    const st = stenosisEstimate(diameterProfile(vol, cpr.rows))
    expect(st.percent).toBeGreaterThan(40)
    // the stenosis sits ~55% of the way down the LAD
    const ladLength = cpr.length - lmLength
    expect(Math.abs(st.at - (lmLength + 0.55 * ladLength))).toBeLessThan(12)
  }, 60000)

  it('proposes paths that start at the ostia', () => {
    expect(proposedPath('LAD')[0]).toEqual(CENTERLINES.LM[0])
    expect(proposedPath('RCA')[0]).toEqual(CENTERLINES.RCA[0])
  })
})
