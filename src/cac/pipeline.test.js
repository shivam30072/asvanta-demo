import { beforeAll, describe, expect, it } from 'vitest'
import { CARDIAC_SERIES, PHANTOM_ANATOMY } from '../imaging/phantom'
import { loadVolume, voxelToWorld } from '../imaging/volume'
import { cacCategory, runCacAnalysis } from './pipeline'
import { applyOp, blockers, createReview, currentTotals, reportText } from './review'
import { validateSeries } from './validation'

const [CAC, CTA, SURVEY] = CARDIAC_SERIES
const geometry = (s) => ({ slices: s.slices, increment: s.increment })

describe('scan validation', () => {
  it('passes the dedicated gated non-contrast 3 mm series', () => {
    const v = validateSeries(CAC.dicom, geometry(CAC), { anatomyModel: true })
    expect(v.verdict).toBe('ready')
    expect(v.dedicated).toBe(true)
  })
  it('refuses the contrast-enhanced CTA', () => {
    const v = validateSeries(CTA.dicom, geometry(CTA), { anatomyModel: true })
    expect(v.verdict).toBe('unsuitable')
    expect(v.checks.find((c) => c.id === 'contrast').status).toBe('fail')
  })
  it('allows the non-gated 5 mm survey only as an opportunistic estimate', () => {
    const v = validateSeries(SURVEY.dicom, geometry(SURVEY), { anatomyModel: true })
    expect(v.verdict).toBe('opportunistic')
    expect(v.checks.filter((c) => c.status === 'warn').map((c) => c.id)).toEqual(expect.arrayContaining(['gating', 'thickness']))
  })
  it('refuses a series with no HU calibration', () => {
    const v = validateSeries({ ...CAC.dicom, RescaleSlope: null }, geometry(CAC), { anatomyModel: true })
    expect(v.verdict).toBe('unsuitable')
  })
})

describe('CAC pipeline on the cardiac phantom', () => {
  let vol
  let result
  beforeAll(async () => {
    vol = await loadVolume({ id: 'test-cac', phantom: CAC })
    result = await runCacAnalysis({ vol, meta: CAC.dicom, anatomy: PHANTOM_ANATOMY })
  }, 60000)

  it('converts stored values to HU with the rescale tags', () => {
    expect(vol.rescale).toEqual({ slope: 1, intercept: -1024 })
    // air outside the body
    expect(vol.hu[0]).toBeLessThan(-900)
  })

  it('is a standard analysis and excludes bone, valve and aortic-wall calcium', () => {
    expect(result.kind).toBe('standard')
    const reasons = result.excluded.map((x) => x.reason)
    expect(reasons.filter((r) => r.startsWith('Bone')).length).toBeGreaterThan(0)
    expect(reasons).toContain('Aortic valve / root')
    expect(reasons).toContain('Outside heart region')
  })

  it('every kept lesion obeys the Agatston rules', () => {
    for (const l of result.lesions) {
      expect(l.peakHu).toBeGreaterThanOrEqual(130)
      for (const r of l.regions) expect(r.areaMm2).toBeGreaterThanOrEqual(1 - 1e-9)
    }
    const sum = result.lesions.reduce((a, l) => a + l.score, 0)
    expect(result.totals.total).toBeCloseTo(sum, 6)
  })

  it('is reproducible', async () => {
    const again = await runCacAnalysis({ vol, meta: CAC.dicom, anatomy: PHANTOM_ANATOMY })
    expect(again.totals).toEqual(result.totals)
  })

  it('refuses an opportunistic series unless explicitly requested', async () => {
    const sv = await loadVolume({ id: 'test-survey', phantom: SURVEY })
    await expect(runCacAnalysis({ vol: sv, meta: SURVEY.dicom, anatomy: PHANTOM_ANATOMY })).rejects.toThrow(/explicitly/)
    const r = await runCacAnalysis({ vol: sv, meta: SURVEY.dicom, anatomy: PHANTOM_ANATOMY, allowOpportunistic: true })
    expect(r.kind).toBe('opportunistic')
  }, 60000)

  it('radiologist corrections change the final score, never the algorithm record', () => {
    const user = 'Dr. Test'
    let rv = createReview(result, user)
    const algorithmTotal = result.totals.total

    // the mitral annulus calcification lands on the LCX — delete it
    const mac = rv.lesions.find((l) => {
      const [x, y, z] = voxelToWorld(vol, l.centroid)
      return Math.hypot(x - 166, y - 122, z - 68) < 4
    })
    expect(mac.vessel).toBe('LCX')
    rv = applyOp(rv, { type: 'delete', id: mac.id, reason: 'Mitral annulus calcification' }, { vol, user })

    // the bifurcation plaque was assigned to LM — move it to the LAD
    const lm = rv.lesions.find((l) => l.vessel === 'LM')
    rv = applyOp(rv, { type: 'vessel', id: lm.id, vessel: 'LAD' }, { vol, user })

    // the distal RCA plaque fell outside the heart region — restore it
    const missed = rv.excluded.find((x) => x.reason === 'Outside heart region' && voxelToWorld(vol, x.centroid)[2] > 95)
    rv = applyOp(rv, { type: 'restore', id: missed.id, vessel: 'RCA' }, { vol, user })

    expect(blockers(rv).ok).toBe(false)
    expect(() => applyOp(rv, { type: 'approve' }, { vol, user })).toThrow()
    rv = applyOp(rv, { type: 'accept-all' }, { vol, user })
    rv = applyOp(rv, { type: 'approve' }, { vol, user })

    const t = currentTotals(rv)
    expect(rv.status).toBe('approved')
    expect(t.LM).toBe(0)
    expect(rv.approved.totals.total).toBeCloseTo(algorithmTotal - mac.score + missed.score, 6)
    expect(rv.algorithm.totals.total).toBe(algorithmTotal)
    expect(rv.approved.delta).toBeCloseTo(rv.approved.totals.total - algorithmTotal, 6)
    expect(rv.audit.map((a) => a.action)).toEqual([
      'Algorithm analysis', 'Deleted lesion', 'Changed vessel', 'Restored excluded candidate', 'Accepted all lesions', 'Approved final score',
    ])
    expect(() => applyOp(rv, { type: 'accept-all' }, { vol, user })).toThrow(/locked/)
    expect(reportText(rv.approved)).toMatch(/Agatston\): total \d+/)
  })

  it('a radiologist can add a lesion by clicking calcium and erase part of one', () => {
    const user = 'Dr. Test'
    let rv = createReview(result, user)
    const x = rv.excluded.find((e) => e.reason === 'Aortic valve / root')
    const seed = x.voxels[Math.floor(x.voxels.length / 2)]
    rv = applyOp(rv, { type: 'add', seed, vessel: 'RCA' }, { vol, user })
    const added = rv.lesions[rv.lesions.length - 1]
    expect(added.source).toBe('manual')
    expect(added.score).toBeGreaterThan(0)

    const big = [...rv.lesions].sort((a, b) => b.voxels.length - a.voxels.length)[0]
    const half = big.voxels.slice(0, Math.floor(big.voxels.length / 2))
    const next = applyOp(rv, { type: 'erase', id: big.id, voxels: half }, { vol, user })
    const after = next.lesions.find((l) => l.id === big.id)
    expect(after ? after.score : 0).toBeLessThan(big.score)
  })
})

describe('CAC-DRS categories', () => {
  it.each([[0, 'A0'], [0.4, 'A0'], [1, 'A1'], [99, 'A1'], [100, 'A2'], [299, 'A2'], [300, 'A3']])('%f → %s', (s, c) => {
    expect(cacCategory(s).code).toBe(`CAC-DRS ${c}`)
  })
})
