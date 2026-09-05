import { anatomyFor } from './synth'

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

export function buildSeries(study) {
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
