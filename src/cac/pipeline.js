/**
 * The CAC analysis pipeline, stage by stage as in the specification. The Agatston
 * maths is real (./agatston); the anatomy steps call an `anatomy` provider:
 *
 *   anatomy.inHeart(x, y, z)          heart localisation
 *   anatomy.nonCoronary(x, y, z)      → reason string if the spot is valvular etc.
 *   anatomy.centerlines               { LM: [[x,y,z,r]...], LAD, LCX, RCA } for vessel assignment
 *
 * In the demo the provider is the phantom's deliberately imperfect model; in
 * production it is a segmentation model (heart, aorta, valves) plus coronary
 * centerline extraction.
 */
import { agatston, scoreVoxels } from './agatston'
import { validateSeries } from './validation'
import { sampleCurve } from '../imaging/phantom'
import { voxelToWorld } from '../imaging/volume'

export const ENGINE_VERSION = 'cac-engine-web-1.0.0'
export const VESSELS = ['LM', 'LAD', 'LCX', 'RCA']
const ASSIGN_MAX_MM = 7
const MAX_CORONARY_VOLUME_MM3 = 1500

/** Used when there is no anatomy model: nothing is localised, nothing is assigned. */
export const MANUAL_ANATOMY = { inHeart: () => true, nonCoronary: () => null, centerlines: {}, manual: true }

export const STAGES = [
  { key: 'dicom', label: 'DICOM validation' },
  { key: 'series', label: 'Series selection' },
  { key: 'volume', label: '3D volume reconstruction' },
  { key: 'hu', label: 'HU conversion' },
  { key: 'acq', label: 'Acquisition / image-quality validation' },
  { key: 'heart', label: 'Heart localisation' },
  { key: 'candidates', label: 'Calcium candidate detection (≥130 HU)' },
  { key: 'segment', label: 'Calcium segmentation (≥1 mm², 8-connected)' },
  { key: 'filter', label: 'Non-coronary calcium filtering' },
  { key: 'vessels', label: 'Vessel assignment' },
  { key: 'score', label: 'Agatston calculation' },
]

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * Sum lesion scores per vessel. Lesions not yet assigned to a vessel count toward
 * the total and are reported as `unassigned` (same convention as the Python engine);
 * approval requires every lesion to have a vessel, so a final score never has any.
 */
export function vesselTotals(lesions) {
  const t = { LM: 0, LAD: 0, LCX: 0, RCA: 0, unassigned: 0 }
  for (const l of lesions) t[t[l.vessel] != null && l.vessel !== 'unassigned' ? l.vessel : 'unassigned'] += l.score
  return { ...t, total: t.LM + t.LAD + t.LCX + t.RCA + t.unassigned }
}

/** CAC-DRS Agatston category. */
export function cacCategory(total) {
  const s = Math.round(total)
  if (s === 0) return { code: 'CAC-DRS A0', label: 'No coronary calcium' }
  if (s < 100) return { code: 'CAC-DRS A1', label: 'Mild' }
  if (s < 300) return { code: 'CAC-DRS A2', label: 'Moderate' }
  return { code: 'CAC-DRS A3', label: 'Severe' }
}

function nearestVessel(centerSamples, p) {
  let best = { vessel: null, dist: Infinity }
  for (const [vessel, samples] of Object.entries(centerSamples)) {
    for (const s of samples) {
      const d = Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2])
      if (d < best.dist) best = { vessel, dist: d }
    }
  }
  return best
}

/**
 * Run the full analysis. `onStage(key, status, detail)` reports progress so the UI
 * can show the pipeline as it runs. Throws if the series is unsuitable, or if it is
 * only fit for an opportunistic estimate and that was not explicitly requested.
 */
export async function runCacAnalysis({ vol, meta, anatomy: model, allowOpportunistic = false, onStage = () => {}, user = 'System' }) {
  const anatomy = model || MANUAL_ANATOMY
  const stage = async (key, detail, fn) => {
    onStage(key, 'running')
    await tick()
    const out = fn ? fn() : undefined
    onStage(key, 'done', typeof detail === 'function' ? detail(out) : detail)
    return out
  }

  const geometry = { slices: vol.dims[2], increment: vol.spacing[2] }
  const validation = validateSeries(meta, geometry, { anatomyModel: !anatomy.manual })
  await stage('dicom', `${meta.Modality} · ${meta.SeriesDescription || 'series'} · ${meta.Manufacturer || ''}`)
  if (validation.verdict === 'unsuitable') {
    onStage('series', 'failed', 'Series is not suitable for CAC scoring')
    throw new Error('Series is not suitable for CAC scoring')
  }
  if (validation.verdict === 'opportunistic' && !allowOpportunistic) {
    onStage('series', 'failed', 'Opportunistic assessment must be requested explicitly')
    throw new Error('Opportunistic assessment must be requested explicitly')
  }
  await stage('series', validation.dedicated ? 'Dedicated CAC series' : 'Opportunistic — non-standard series')
  await stage('volume', `${vol.dims[0]}×${vol.dims[1]}×${vol.dims[2]} voxels`)
  await stage('hu', vol.rescale ? `HU = stored × ${vol.rescale.slope} + (${vol.rescale.intercept})` : 'Values already in HU')
  await stage('acq', () => {
    const w = validation.checks.filter((c) => c.status === 'warn').length
    return w ? `${w} protocol warning${w > 1 ? 's' : ''}` : 'All acquisition checks passed'
  })
  await stage('heart', anatomy.manual ? 'Skipped — manual mode' : 'Heart region located')

  const raw = await stage('candidates', (r) => `${r.regions.length} regions ≥130 HU and ≥1 mm²`, () => agatston(vol))
  await stage('segment', `${raw.lesions.length} connected lesions`)

  const kept = []
  const excluded = []
  await stage('filter', () => `${kept.length} kept · ${excluded.length} excluded`, () => {
    raw.lesions.forEach((l, i) => {
      const p = voxelToWorld(vol, l.centroid)
      let reason = null
      if (l.volumeMm3 > MAX_CORONARY_VOLUME_MM3) reason = 'Bone (too large for coronary calcium)'
      else if (!anatomy.inHeart(...p)) reason = 'Outside heart region'
      else reason = anatomy.nonCoronary(...p)
      const lesion = { ...l, key: `L${i + 1}`, world: p }
      if (reason) excluded.push({ ...lesion, reason })
      else kept.push(lesion)
    })
  })

  const centerSamples = Object.fromEntries(Object.entries(anatomy.centerlines).map(([k, pts]) => [k, sampleCurve(pts, 0.5)]))
  await stage('vessels', () => (anatomy.manual ? 'Skipped — assign vessels during review' : `${kept.filter((l) => l.vessel).length} of ${kept.length} assigned`), () => {
    for (const l of kept) {
      const n = nearestVessel(centerSamples, l.world)
      l.vessel = n.dist <= ASSIGN_MAX_MM ? n.vessel : null
      l.vesselDistMm = n.dist
    }
  })

  const lesions = kept.map((l, i) => toLesion(l, `A${i + 1}`, 'algorithm'))
  const totals = await stage('score', (t) => `Total ${Math.round(t.total)}`, () => vesselTotals(lesions))

  return {
    engineVersion: ENGINE_VERSION,
    manual: Boolean(anatomy.manual),
    kind: validation.dedicated ? 'standard' : 'opportunistic',
    validation,
    at: new Date().toISOString(),
    runBy: user,
    lesions,
    excluded: excluded.map((l, i) => ({ ...toLesion(l, `X${i + 1}`, 'algorithm'), reason: l.reason })),
    totals,
  }
}

/** The fields a lesion carries through review and into the audit record. */
export function toLesion(l, id, source) {
  return {
    id,
    source,
    vessel: l.vessel ?? null,
    status: source === 'algorithm' ? 'pending' : 'accepted',
    voxels: l.voxels,
    score: l.score,
    areaMm2: l.areaMm2,
    peakHu: l.peakHu,
    factor: Math.max(...l.regions.map((r) => r.factor)),
    volumeMm3: l.volumeMm3,
    zRange: l.zRange,
    centroid: l.centroid,
    regions: l.regions.map((r) => ({ z: r.z, areaMm2: r.areaMm2, peakHu: r.peakHu, factor: r.factor, score: r.score })),
  }
}

/** Re-score a lesion from (possibly edited) voxels. */
export function rescore(vol, lesion, voxels) {
  const s = scoreVoxels(vol, voxels)
  return {
    ...lesion,
    voxels: s.voxels,
    score: s.score,
    areaMm2: s.areaMm2,
    peakHu: s.peakHu,
    factor: s.regions.length ? Math.max(...s.regions.map((r) => r.factor)) : 0,
    volumeMm3: s.volumeMm3,
    zRange: s.zRange,
    centroid: s.centroid,
    regions: s.regions.map((r) => ({ z: r.z, areaMm2: r.areaMm2, peakHu: r.peakHu, factor: r.factor, score: r.score })),
  }
}
