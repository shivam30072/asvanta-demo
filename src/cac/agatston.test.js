import { describe, expect, it } from 'vitest'
import reference from '../../reference/cac-cases.json'
import { agatston, densityFactor, regionGrow, scoreVoxels } from './agatston'

/** Build an HU volume from the reference-case description. */
function build(c) {
  const [nx, ny, nz] = c.dims
  const hu = new Float32Array(nx * ny * nz).fill(c.background)
  for (const b of c.boxes || []) {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) hu[b.z * nx * ny + y * nx + x] = b.hu
  }
  for (const p of c.pixels || []) hu[p.z * nx * ny + p.y * nx + p.x] = p.hu
  return { hu, dims: c.dims, spacing: c.spacing }
}

describe('reference cases (shared with the Python engine)', () => {
  it.each(reference.cases.map((c) => [c.name, c]))('%s', (_, c) => {
    const r = agatston(build(c))
    expect(r.total).toBeCloseTo(c.expected.total, 6)
    expect(r.regions.length).toBe(c.expected.regions)
    expect(r.lesions.length).toBe(c.expected.lesions)
  })
})

describe('densityFactor', () => {
  it.each([
    [129, 0], [130, 1], [199, 1], [200, 2], [299, 2], [300, 3], [399, 3], [400, 4], [1500, 4],
  ])('%i HU -> %i', (hu, f) => expect(densityFactor(hu)).toBe(f))
})

describe('lesion detail', () => {
  const c = reference.cases.find((x) => x.name === 'one-lesion-across-three-slices-weighted-per-slice')
  const vol = build(c)
  const r = agatston(vol)

  it('reports peak HU, slice range and volume', () => {
    const [l] = r.lesions
    expect(l.peakHu).toBe(420)
    expect(l.zRange).toEqual([0, 2])
    expect(l.voxels.length).toBe(16 + 16 + 9)
    expect(l.volumeMm3).toBeCloseTo(41 * 0.5 * 0.5 * 3, 6)
  })

  it('rescoring a lesion from its own voxels gives the same score', () => {
    const [l] = r.lesions
    expect(scoreVoxels(vol, l.voxels).score).toBeCloseTo(l.score, 6)
  })

  it('erasing a slice from a lesion removes that slice’s contribution', () => {
    const [l] = r.lesions
    const plane = c.dims[0] * c.dims[1]
    const kept = l.voxels.filter((v) => Math.floor(v / plane) !== 1)
    expect(scoreVoxels(vol, kept).score).toBeCloseTo(4 + 4.5, 6)
  })
})

describe('regionGrow', () => {
  it('grows a seed into the whole connected lesion across slices', () => {
    const c = reference.cases.find((x) => x.name === 'one-lesion-across-three-slices-weighted-per-slice')
    const vol = build(c)
    const [nx, ny] = c.dims
    const grown = regionGrow(vol, 1 * nx * ny + 4 * nx + 4)
    expect(grown.length).toBe(41)
    expect(scoreVoxels(vol, grown).score).toBeCloseTo(24.5, 6)
  })

  it('returns nothing when the seed is below threshold', () => {
    const c = reference.cases.find((x) => x.name === 'empty')
    expect(regionGrow(build(c), 0)).toEqual([])
  })
})
