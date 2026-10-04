/**
 * Is this series fit for a formal Agatston score?
 *
 * Agatston was defined on non-contrast, ECG-gated CT at 120 kVp reconstructed at
 * 3 mm. Departures from that either invalidate the score outright (contrast:
 * iodine in the blood pool is above 130 HU) or make it a non-standard,
 * opportunistic estimate that must be labelled as such.
 *
 * Verdicts:
 *   ready          dedicated CAC acquisition — standard Agatston
 *   opportunistic  scoring possible, but the result is an estimate and is labelled so
 *   unsuitable     must not be scored
 */

export const RULES = {
  thicknessMm: [2.5, 3.0],
  maxPixelMm: 1.0,
  kvp: 120,
  minCoverageMm: 100,
}

const check = (id, label, status, detail) => ({ id, label, status, detail })

/** `meta` holds DICOM-style tags; `geometry` the slice count and increment actually loaded. */
export function validateSeries(meta, geometry, { anatomyModel = false } = {}) {
  const checks = []
  const t = meta || {}

  checks.push(
    t.Modality === 'CT'
      ? check('modality', 'CT acquisition', 'pass', 'Modality CT')
      : check('modality', 'CT acquisition', 'fail', `Modality ${t.Modality || 'unknown'} — calcium scoring needs CT`)
  )

  checks.push(
    t.RescaleSlope != null && t.RescaleIntercept != null
      ? check('hu', 'HU calibration available', 'pass', `Rescale slope ${t.RescaleSlope}, intercept ${t.RescaleIntercept}`)
      : check('hu', 'HU calibration available', 'fail', 'No RescaleSlope / RescaleIntercept — pixel values cannot be converted to HU')
  )

  checks.push(
    t.ContrastBolusAgent
      ? check('contrast', 'Non-contrast study', 'fail', `Contrast agent recorded (${t.ContrastBolusAgent}) — enhanced blood exceeds 130 HU`)
      : check('contrast', 'Non-contrast study', 'pass', 'No contrast agent recorded')
  )

  const gated = Boolean(t.CardiacSynchronizationTechnique && t.CardiacSynchronizationTechnique !== 'NONE')
  checks.push(
    gated
      ? check('gating', 'ECG-gated', 'pass', `${t.CardiacSynchronizationTechnique.toLowerCase()} gating${t.NominalPercentageOfCardiacPhase ? ` at ${t.NominalPercentageOfCardiacPhase}% R-R` : ''}`)
      : check('gating', 'ECG-gated', 'warn', 'Non-gated — cardiac motion blurs calcium; score is an opportunistic estimate')
  )

  const th = t.SliceThickness
  const [lo, hi] = RULES.thicknessMm
  checks.push(
    th >= lo && th <= hi
      ? check('thickness', 'Slice thickness 2.5–3 mm', 'pass', `${th} mm`)
      : check('thickness', 'Slice thickness 2.5–3 mm', 'warn', `${th ?? '?'} mm — Agatston is defined at 3 mm; scores at other thicknesses are not comparable`)
  )

  const inc = geometry?.increment
  checks.push(
    inc && th && Math.abs(inc - th) < 0.05
      ? check('spacing', 'Contiguous slices', 'pass', `Increment ${inc} mm, no gaps or overlap`)
      : check('spacing', 'Contiguous slices', 'warn', `Increment ${inc ?? '?'} mm vs thickness ${th ?? '?'} mm`)
  )

  const px = t.PixelSpacing?.[0]
  checks.push(
    px && px <= RULES.maxPixelMm
      ? check('pixel', 'Pixel spacing ≤ 1 mm', 'pass', `${px.toFixed(2)} mm`)
      : check('pixel', 'Pixel spacing ≤ 1 mm', 'warn', `${px ? px.toFixed(2) : '?'} mm — small lesions fall under the 1 mm² minimum`)
  )

  checks.push(
    t.KVP === RULES.kvp
      ? check('kvp', 'Tube voltage 120 kVp', 'pass', '120 kVp')
      : check('kvp', 'Tube voltage 120 kVp', 'warn', `${t.KVP ?? '?'} kVp — the 130 HU threshold assumes 120 kVp`)
  )

  const iop = t.ImageOrientationPatient
  const axial = iop && Math.abs(iop[0]) > 0.99 && Math.abs(iop[4]) > 0.99
  checks.push(
    axial
      ? check('orientation', 'Axial orientation', 'pass', 'Axial slices')
      : check('orientation', 'Axial orientation', 'fail', 'Not axial — areas would be measured in the wrong plane')
  )

  const coverage = geometry ? geometry.slices * (geometry.increment || 0) : 0
  checks.push(
    coverage >= RULES.minCoverageMm
      ? check('coverage', 'Heart covered', 'pass', `${Math.round(coverage)} mm cranio-caudal coverage`)
      : check('coverage', 'Heart covered', 'warn', `Only ${Math.round(coverage)} mm covered — heart may be cut off`)
  )

  // anatomy does not change whether Agatston is valid, only how much the radiologist must do
  checks.push(
    anatomyModel
      ? check('anatomy', 'Heart & coronary localisation', 'pass', 'Anatomy model available for this series')
      : check('anatomy', 'Heart & coronary localisation', 'info', 'Manual mode: no heart or vessel model for this series — only bone is filtered out, and you assign every lesion to a vessel')
  )

  const hasFail = checks.some((c) => c.status === 'fail')
  const hasWarn = checks.some((c) => c.status === 'warn')
  const dedicated = gated && th >= lo && th <= hi && !t.ContrastBolusAgent
  const verdict = hasFail ? 'unsuitable' : hasWarn ? 'opportunistic' : 'ready'
  return { checks, verdict, dedicated }
}

export const VERDICT_TEXT = {
  ready: { title: 'Ready for analysis', body: 'Dedicated CAC acquisition. A standard Agatston score can be calculated.' },
  opportunistic: {
    title: 'Opportunistic assessment only',
    body: 'This series departs from the Agatston protocol. Any score is a non-standard estimate and will be labelled as one.',
  },
  unsuitable: { title: 'Not suitable for CAC scoring', body: 'A calcium score must not be calculated from this series.' },
}
