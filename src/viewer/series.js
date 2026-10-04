import { anatomyFor, sliceData } from './synth'
import { CARDIAC_SERIES, MATRIX, PIXEL_MM, storedSlice } from '../imaging/phantom'
import { cachedVolume } from '../imaging/volume'

/**
 * Series a study would realistically contain, so the viewer's left rail looks
 * like a real worklist entry rather than one flat pile of images.
 * `w` is a weight — the study's image count is shared out across the series.
 */
const TEMPLATES = {
  'CT|Brain': [
    { name: 'Scout', fixed: 1, thickness: 0 },
    { name: 'Ax Plain 5mm', w: 5, thickness: 5 },
    { name: 'Ax Bone 1mm', w: 6, thickness: 1, preset: 'Bone' },
    { name: 'Cor Recon 3mm', w: 3, thickness: 3, plane: 'Cor' },
  ],
  'CT|Chest': [
    { name: 'Scout', fixed: 1, thickness: 0 },
    { name: 'Ax Lung 1mm', w: 6, thickness: 1, preset: 'Lung' },
    { name: 'Ax Mediastinum 5mm', w: 4, thickness: 5, preset: 'Soft tissue' },
    { name: 'Cor Recon', w: 3, thickness: 3, plane: 'Cor', preset: 'Lung' },
  ],
  'CT|*': [
    { name: 'Scout', fixed: 1, thickness: 0 },
    { name: 'Ax Portal Venous', w: 6, thickness: 3 },
    { name: 'Ax Delayed', w: 5, thickness: 3 },
    { name: 'Cor Recon 3mm', w: 4, thickness: 3, plane: 'Cor' },
  ],
  'MRI|*': [
    { name: 'Sag T1', w: 3, thickness: 4, plane: 'Sag' },
    { name: 'Sag T2 TSE', w: 3, thickness: 4, plane: 'Sag' },
    { name: 'Ax T2 FSE', w: 5, thickness: 4 },
    { name: 'STIR', w: 3, thickness: 4, plane: 'Sag' },
  ],
  'X-Ray|*': [
    { name: 'PA Erect', fixed: 1, thickness: 0 },
    { name: 'Lateral', fixed: 1, thickness: 0 },
  ],
  'Ultrasound|*': [{ name: 'Sweep', w: 1, thickness: 0 }],
  'Mammography|*': [
    { name: 'R CC', fixed: 1, thickness: 0 },
    { name: 'L CC', fixed: 1, thickness: 0 },
    { name: 'R MLO', fixed: 1, thickness: 0 },
    { name: 'L MLO', fixed: 1, thickness: 0 },
  ],
  'PET-CT|*': [
    { name: 'Scout', fixed: 1, thickness: 0 },
    { name: 'CT AC', w: 5, thickness: 3 },
    { name: 'PET Corrected', w: 5, thickness: 3 },
    { name: 'Fused', w: 5, thickness: 3 },
  ],
}

export const WINDOW_PRESETS = {
  CT: [
    { name: 'Soft tissue', ww: 400, wc: 40 },
    { name: 'Brain', ww: 80, wc: 40 },
    { name: 'Lung', ww: 1500, wc: -600 },
    { name: 'Bone', ww: 2000, wc: 400 },
  ],
  MRI: [
    { name: 'Default', ww: 700, wc: 350 },
    { name: 'Bright', ww: 380, wc: 400 },
    { name: 'Dark', ww: 1100, wc: 420 },
  ],
  default: [
    { name: 'Default', ww: 800, wc: 420 },
    { name: 'High contrast', ww: 420, wc: 400 },
    { name: 'Low contrast', ww: 1200, wc: 460 },
  ],
}

export const presetsFor = (modality) => WINDOW_PRESETS[modality] || WINDOW_PRESETS.default

/** Cardiac studies are served from the analytic phantom: a real 3D volume with ground truth. */
export const isCardiac = (study) => study.modality === 'CT' && /cardiac|coronary|calcium/i.test(study.bodyPart)

function cardiacSeries(study) {
  return CARDIAC_SERIES.map((ph, i) => ({
    id: `${study.id}-${ph.key}`,
    number: 200 + i * 2,
    name: ph.name,
    plane: 'Ax',
    thickness: ph.thickness,
    count: ph.slices,
    seed: i,
    anatomy: 'cardiac',
    mri: false,
    ww: ph.contrast ? 800 : 400,
    wc: ph.contrast ? 200 : 40,
    pixelSpacing: PIXEL_MM,
    matrix: MATRIX,
    phantom: ph,
  }))
}

const phantomCache = new Map()

/**
 * Pixel values (HU for CT) for slice `z` of any series. Phantom series read from
 * their loaded volume when there is one, otherwise render the slice on demand.
 * Returns { buf, n } — n is the series' own matrix, which wins over `size`.
 */
export function seriesSlice(series, z, size = 384) {
  if (series.dicomweb) {
    const vol = cachedVolume(series)
    if (!vol) return { buf: null, n: 0 }
    const plane = vol.dims[0] * vol.dims[1]
    return { buf: vol.hu.subarray(z * plane, (z + 1) * plane), n: vol.dims[0], w: vol.dims[0], h: vol.dims[1] }
  }
  if (!series.phantom) return { buf: sliceData(series.anatomy, series.seed, z, series.count, size, series.mri), n: size }
  const n = series.matrix
  const vol = cachedVolume(series)
  if (vol) return { buf: vol.hu.subarray(z * n * n, (z + 1) * n * n), n }
  const key = `${series.id}|${z}`
  let buf = phantomCache.get(key)
  if (!buf) {
    const raw = storedSlice(series.phantom, z, n)
    const { RescaleSlope: m, RescaleIntercept: b } = series.phantom.dicom
    buf = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) buf[i] = raw[i] * m + b
    if (phantomCache.size > 48) phantomCache.delete(phantomCache.keys().next().value)
    phantomCache.set(key, buf)
  }
  return { buf, n }
}

/** Series of a study received from the PACS, as listed by the gateway. */
function pacsSeries(study) {
  const presets = presetsFor(study.modality)
  return (study.seriesList || []).map((s, i) => ({
    id: `${study.id}-${s.seriesInstanceUID}`,
    number: s.number ?? i + 1,
    name: s.description || `Series ${s.number ?? i + 1}`,
    plane: 'Ax',
    thickness: s.thickness || 0,
    count: s.count,
    seed: i,
    anatomy: null,
    mri: s.modality === 'MR',
    // window comes from the images themselves once loaded (see Viewport)
    ww: null,
    wc: null,
    fallbackWindow: presets[0],
    pixelSpacing: null,
    dicomweb: { base: study.dicomwebBase || '/dicomweb', auth: study.dicomwebAuth, studyUID: study.studyInstanceUID, seriesUID: s.seriesInstanceUID },
  }))
}

export function buildSeries(study) {
  if (study.source === 'pacs') return pacsSeries(study)
  if (isCardiac(study)) return cardiacSeries(study)
  const key = `${study.modality}|${study.bodyPart}`
  const tpl = TEMPLATES[key] || TEMPLATES[`${study.modality}|*`] || TEMPLATES['CT|*']
  const anatomy = anatomyFor(study.modality, study.bodyPart)
  const mri = study.modality === 'MRI'
  const presets = presetsFor(study.modality)

  const totalWeight = tpl.reduce((a, t) => a + (t.w || 0), 0)
  const budget = Math.max(tpl.length, study.images - tpl.filter((t) => t.fixed).length)

  return tpl.map((t, i) => {
    const preset = presets.find((p) => p.name === t.preset) || presets[0]
    return {
      id: `${study.id}-s${i}`,
      number: 300 + i * 2,
      name: t.name,
      plane: t.plane || (study.modality === 'Ultrasound' || study.modality === 'X-Ray' || study.modality === 'Mammography' ? '—' : 'Ax'),
      thickness: t.thickness,
      count: t.fixed ? t.fixed : Math.max(3, Math.round((budget * (t.w || 1)) / (totalWeight || 1))),
      seed: i * 7 + 3,
      anatomy,
      mri,
      ww: preset.ww,
      wc: preset.wc,
      pixelSpacing: study.modality === 'Mammography' ? 0.07 : study.modality === 'Ultrasound' ? 0.24 : 0.42, // mm/px
    }
  })
}

/**
 * DICOM-style tags for a series, as the CAC validator reads them. Phantom series
 * carry their own; procedural series get what their protocol implies.
 */
export function seriesMeta(series, study, vol) {
  if (series.phantom) return series.phantom.dicom
  if (series.dicomweb) return vol?.meta || {}
  const ct = study.modality === 'CT' || study.modality === 'PET-CT'
  return {
    Modality: ct ? 'CT' : study.modality === 'MRI' ? 'MR' : study.modality,
    SeriesDescription: series.name,
    Manufacturer: 'Procedural demo',
    SliceThickness: series.thickness || null,
    SpacingBetweenSlices: series.thickness || null,
    PixelSpacing: [(series.pixelSpacing * 384) / 160, (series.pixelSpacing * 384) / 160],
    KVP: ct ? 120 : null,
    ContrastBolusAgent: /portal|delayed|cta|contrast/i.test(series.name) ? 'Iodinated contrast' : null,
    CardiacSynchronizationTechnique: null,
    RescaleSlope: ct ? 1 : null,
    RescaleIntercept: ct ? -1024 : null,
    ImageOrientationPatient: series.plane === 'Ax' ? [1, 0, 0, 0, 1, 0] : [1, 0, 0, 0, 0, -1],
  }
}
