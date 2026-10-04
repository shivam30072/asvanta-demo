/**
 * Analytic cardiac CT phantom.
 *
 * A stand-in for a real cardiac CT so MPR, CPR and calcium scoring have a true 3D
 * volume with known ground truth: coronary centerlines, calcified plaques with set
 * peak HU, and the high-density structures a calcium score must NOT count (spine,
 * ribs, sternum, aortic valve, mitral annulus, aortic wall).
 *
 * World space is millimetres: x runs patient right → left (image left → right),
 * y anterior → posterior (image top → bottom), z superior → inferior.
 */

/* ----------------------------------------------------------------- geometry */

export const FOV_MM = 250
export const MATRIX = 320
export const PIXEL_MM = FOV_MM / MATRIX // 0.78125

const BODY = { cx: 125, cy: 128, rx: 118, ry: 90 }
const SPINE = { cx: 125, cy: 192, r: 16 }

// heart: an ellipsoid rotated in-plane so the apex points anterior-left-inferior
const HEART = { cx: 140, cy: 112, cz: 86, rx: 50, ry: 42, rz: 48, rot: -0.55 }
const CHAMBERS = {
  lv: { cx: 156, cy: 116, cz: 92, rx: 21, ry: 17, rz: 30, rot: -0.55 },
  rv: { cx: 122, cy: 96, cz: 88, rx: 24, ry: 13, rz: 30, rot: -0.55 },
  la: { cx: 140, cy: 140, cz: 62, rx: 22, ry: 13, rz: 14, rot: 0 },
  ra: { cx: 108, cy: 120, cz: 76, rx: 15, ry: 18, rz: 22, rot: 0 },
}
const AORTA_ASC = { cx: 120, cy: 102, r: 14, z0: -20, z1: 56 }
const AORTA_DESC = { cx: 152, cy: 168, r: 12 }
const PULM_TRUNK = { cx: 142, cy: 86, r: 12, z0: -20, z1: 44 }

/** Coronary centerlines: [x, y, z, radius] control points in mm. */
export const CENTERLINES = {
  LM: [[129, 101, 53, 2.3], [137, 97, 55, 2.2], [143, 94, 57, 2.1]],
  LAD: [[143, 94, 57, 2.0], [145, 80, 61, 1.9], [150, 68, 70, 1.7], [159, 66, 86, 1.5], [165, 73, 104, 1.3], [165, 88, 122, 1.0]],
  LCX: [[143, 94, 57, 1.8], [155, 103, 60, 1.6], [168, 117, 66, 1.5], [176, 134, 74, 1.3], [174, 150, 85, 1.1]],
  RCA: [[112, 99, 55, 2.0], [103, 90, 61, 1.9], [97, 97, 71, 1.8], [91, 112, 83, 1.6], [95, 130, 97, 1.4], [106, 143, 108, 1.2]],
}

export const VESSELS = ['LM', 'LAD', 'LCX', 'RCA']

/**
 * Calcified coronary plaques (ground truth). `t` is the fraction of the way along
 * the vessel, `side` the angle around it where the plaque sits in the wall.
 */
export const PLAQUES = [
  { id: 'P1', vessel: 'LAD', t: 0.03, r: 1.7, peak: 390, side: 0.6 }, // at the LM bifurcation
  { id: 'P2', vessel: 'LAD', t: 0.18, r: 2.2, peak: 560, side: 2.4 },
  { id: 'P3', vessel: 'LAD', t: 0.38, r: 1.9, peak: 330, side: -1.0 },
  { id: 'P4', vessel: 'LCX', t: 0.30, r: 2.0, peak: 300, side: 1.2 },
  { id: 'P5', vessel: 'RCA', t: 0.18, r: 2.1, peak: 470, side: 0.4 },
  { id: 'P6', vessel: 'RCA', t: 0.52, r: 1.9, peak: 290, side: 2.0 },
  { id: 'P7', vessel: 'RCA', t: 0.90, r: 2.0, peak: 380, side: -0.8 }, // distal, where heart localisation falls short
]

/** Non-calcified (soft) stenosis, visible on the contrast series only. */
export const SOFT_STENOSES = [{ vessel: 'LAD', t: 0.55, length: 8, narrowing: 0.5 }]

/** High-density structures that are not coronary calcium. */
export const DISTRACTORS = [
  // mitral annulus calcification, lying in the AV groove right beside the LCX
  { id: 'MAC', kind: 'Mitral annulus', x: 166, y: 122, z: 68, rx: 3.2, ry: 1.9, rz: 2.4, peak: 560 },
  // aortic valve cusps
  { id: 'AV1', kind: 'Aortic valve', x: 116, y: 106, z: 57, rx: 2.4, ry: 1.8, rz: 2.4, peak: 520 },
  { id: 'AV2', kind: 'Aortic valve', x: 124, y: 111, z: 58, rx: 2.0, ry: 1.6, rz: 2.0, peak: 430 },
  // descending aortic wall
  { id: 'AW', kind: 'Aortic wall', x: 161, y: 164, z: 78, rx: 2.6, ry: 2.0, rz: 5.0, peak: 600 },
]

/* --------------------------------------------------------------- curve math */

/** Catmull-Rom spline through control points, sampled every `step` mm. */
export function sampleCurve(points, step = 0.25) {
  if (points.length < 2) return points.map((p) => [...p])
  const out = []
  const P = [points[0], ...points, points[points.length - 1]]
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]]
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2])
    const n = Math.max(2, Math.ceil(seg / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      out.push(
        p1.map((_, d) =>
          0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)
        )
      )
    }
  }
  out.push([...points[points.length - 1]])
  return out
}

/** Arc-length table for a sampled curve. */
export function arcLengths(samples) {
  const s = [0]
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
  }
  return s
}

/** Point, unit tangent and an orthonormal frame at fraction `t` along a sampled curve. */
export function frameAt(samples, lengths, t) {
  const total = lengths[lengths.length - 1]
  const target = Math.max(0, Math.min(1, t)) * total
  let i = 1
  while (i < lengths.length - 1 && lengths[i] < target) i++
  const a = samples[i - 1]
  const b = samples[i]
  const f = (target - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1])
  const p = a.map((v, d) => v + (b[d] - v) * f)
  let tan = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const tl = Math.hypot(...tan) || 1
  tan = tan.map((v) => v / tl)
  // reference "up" is the z axis unless the vessel runs nearly along it
  const ref = Math.abs(tan[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]
  let u = cross(tan, ref)
  const ul = Math.hypot(...u) || 1
  u = u.map((v) => v / ul)
  const v = cross(tan, u)
  return { p, tan, u, v }
}

export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/* -------------------------------------------------------------- randomness */

const hash = (a, b, c) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1103515245)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const gauss = (a, b, c) => {
  const u = Math.max(1e-9, hash(a, b, c))
  const v = hash(a + 7919, b, c)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/* ------------------------------------------------------------------ the model */

const ellD = (x, y, cx, cy, rx, ry, rot = 0) => {
  let dx = x - cx
  let dy = y - cy
  if (rot) {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    ;[dx, dy] = [dx * c + dy * s, -dx * s + dy * c]
  }
  return Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
}

/** Cross-section of an ellipsoid at height z: scale factor for its in-plane radii, 0 if absent. */
const zScale = (e, z) => {
  const q = (z - e.cz) / e.rz
  return q >= 1 ? 0 : Math.sqrt(1 - q * q)
}

const VESSEL_SAMPLES = Object.fromEntries(
  Object.entries(CENTERLINES).map(([k, pts]) => {
    const s = sampleCurve(pts, 0.3)
    return [k, { samples: s, lengths: arcLengths(s) }]
  })
)

/** Plaque and stenosis positions in world space. */
const PLAQUE_POS = PLAQUES.map((pl) => {
  const vs = VESSEL_SAMPLES[pl.vessel]
  const f = frameAt(vs.samples, vs.lengths, pl.t)
  // radius of the vessel at t, interpolated from the control points
  const pts = CENTERLINES[pl.vessel]
  const rad = pts[Math.min(pts.length - 1, Math.round(pl.t * (pts.length - 1)))][3]
  const off = rad * 0.75
  const dir = f.u.map((uu, d) => uu * Math.cos(pl.side) + f.v[d] * Math.sin(pl.side))
  return { ...pl, x: f.p[0] + dir[0] * off, y: f.p[1] + dir[1] * off, z: f.p[2] + dir[2] * off }
})

export const plaquePositions = () => PLAQUE_POS.map((p) => ({ ...p }))

function stenosisFactor(vessel, s, total) {
  for (const st of SOFT_STENOSES) {
    if (st.vessel !== vessel) continue
    const d = Math.abs(s - st.t * total)
    if (d < st.length / 2) return 1 - st.narrowing * Math.cos((d / (st.length / 2)) * (Math.PI / 2)) ** 2
  }
  return 1
}

/**
 * HU values for one axial plane at height z (mm), n×n pixels covering the FOV.
 * `contrast`: iodinated blood pool. No noise or blur here — see renderSlab.
 */
function evaluatePlane(out, n, z, contrast) {
  const px = FOV_MM / n
  const blood = contrast ? 420 : 40
  const rightBlood = contrast ? 260 : 40
  const myo = contrast ? 115 : 46
  const fat = -95
  const mediast = contrast ? 55 : 32

  const hs = zScale(HEART, z)
  const ch = Object.fromEntries(Object.entries(CHAMBERS).map(([k, e]) => [k, zScale(e, z)]))

  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) * px
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * px
      const d = ellD(x, y, BODY.cx, BODY.cy, BODY.rx, BODY.ry)
      let v = -1000
      if (d < 1) {
        if (d > 0.975) v = 0
        else if (d > 0.9) v = -90
        else if (d > 0.84) v = 50
        else {
          // lungs, carved by the heart and mediastinum
          const lungR = ellD(x, y, 78, 122, 44, 66, 0.1)
          const lungL = ellD(x, y, 174, 122, 42, 64, -0.1)
          v = lungR < 1 || lungL < 1 ? -860 : mediast
          // mediastinum between the lungs
          if (ellD(x, y, 128, 112, 34, 72) < 1) v = mediast

          if (hs > 0) {
            const hd = ellD(x, y, HEART.cx, HEART.cy, HEART.rx * hs, HEART.ry * hs, HEART.rot)
            if (hd < 1.12) v = fat // epicardial fat wraps the heart
            if (hd < 1) {
              v = myo
              for (const k of ['lv', 'rv', 'la', 'ra']) {
                const e = CHAMBERS[k]
                if (ch[k] > 0 && ellD(x, y, e.cx, e.cy, e.rx * ch[k], e.ry * ch[k], e.rot) < 1) {
                  v = k === 'lv' || k === 'la' ? blood : rightBlood
                }
              }
            }
          }

          // great vessels
          if (z >= AORTA_ASC.z0 && z <= AORTA_ASC.z1 && Math.hypot(x - AORTA_ASC.cx, y - AORTA_ASC.cy) < AORTA_ASC.r) v = blood
          if (z >= PULM_TRUNK.z0 && z <= PULM_TRUNK.z1 && Math.hypot(x - PULM_TRUNK.cx, y - PULM_TRUNK.cy) < PULM_TRUNK.r) v = rightBlood
          if (Math.hypot(x - AORTA_DESC.cx, y - AORTA_DESC.cy) < AORTA_DESC.r) v = blood
          if (Math.hypot(x - AORTA_DESC.cx, y - AORTA_DESC.cy) < AORTA_DESC.r + 2 && Math.hypot(x - AORTA_DESC.cx, y - AORTA_DESC.cy) >= AORTA_DESC.r) v = 40

          // sternum: anterior midline, marrow inside a cortical shell
          const st = ellD(x, y, 125, 47, 15, 6.5)
          if (st < 1) v = st > 0.72 ? 720 : 210
        }

        // ribs: slanted bands in the chest wall, lower anteriorly
        if (d > 0.8 && d < 0.9) {
          const anteriorMid = Math.abs(x - 125) < 26 && y < 70
          if (!anteriorMid) {
            for (let k = -1; k < 7; k++) {
              const zc = 6 + 25 * k + 0.32 * (BODY.cy - y)
              const dz = Math.abs(z - zc)
              if (dz < 5.5) {
                const band = Math.abs(d - 0.85) / 0.05
                const r = Math.hypot(band, dz / 5.5)
                if (r < 1) v = r > 0.6 ? 900 : 230
              }
            }
          }
        }

        // vertebra: body with disc spaces, canal and posterior elements
        const vd = Math.hypot(x - SPINE.cx, y - SPINE.cy) / SPINE.r
        const disc = ((z % 26) + 26) % 26 < 5
        if (vd < 1) v = disc ? 85 : vd > 0.8 ? 950 : 260
        const canal = Math.hypot(x - SPINE.cx, y - (SPINE.cy + 23)) < 9
        if (canal) v = 30
        const posterior = ellD(x, y, SPINE.cx, SPINE.cy + 23, 20, 14)
        if (!canal && posterior < 1 && posterior > 0.62 && !disc) v = 780
        const spinous = ellD(x, y, SPINE.cx, SPINE.cy + 42, 5, 10)
        if (spinous < 1 && !disc) v = 760
      }
      out[j * n + i] = v
    }
  }
}

/** Stamp coronaries, plaques and distractor calcium into one plane. */
function stampVessels(out, n, z, contrast) {
  const px = FOV_MM / n
  const lumenHu = contrast ? 380 : 42
  const stampDisc = (cx, cy, r, value, mode) => {
    const i0 = Math.max(0, Math.floor((cx - r) / px))
    const i1 = Math.min(n - 1, Math.ceil((cx + r) / px))
    const j0 = Math.max(0, Math.floor((cy - r) / px))
    const j1 = Math.min(n - 1, Math.ceil((cy + r) / px))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * px - cx
        const dy = (j + 0.5) * px - cy
        if (dx * dx + dy * dy <= r * r) {
          const k = j * n + i
          if (mode === 'set') out[k] = value
          else if (mode === 'fat') out[k] = out[k] > 200 ? out[k] : value
        }
      }
    }
  }

  // fat sleeve, then soft plaque filling the full wall at a stenosis, then the
  // (narrowed) contrast lumen on top — in that order, so later samples along the
  // vessel cannot paint plaque over lumen already drawn
  for (const pass of ['fat', 'plaque', 'lumen']) {
    if (pass === 'plaque' && !contrast) continue
    for (const [vessel, { samples, lengths }] of Object.entries(VESSEL_SAMPLES)) {
      const total = lengths[lengths.length - 1]
      const pts = CENTERLINES[vessel]
      for (let s = 0; s < samples.length; s++) {
        const [cx, cy, cz] = samples[s]
        const t = lengths[s] / total
        const seg = t * (pts.length - 1)
        const a = Math.floor(seg)
        const b = Math.min(pts.length - 1, a + 1)
        const rad = pts[a][3] + (pts[b][3] - pts[a][3]) * (seg - a)
        const narrow = stenosisFactor(vessel, lengths[s], total)
        if (pass === 'plaque' && narrow === 1) continue
        const R = pass === 'fat' ? rad + 3 : pass === 'plaque' ? rad : rad * narrow
        const dz = Math.abs(z - cz)
        if (dz >= R) continue
        const r = Math.sqrt(R * R - dz * dz)
        if (pass === 'fat') stampDisc(cx, cy, r, -85, 'fat')
        else stampDisc(cx, cy, r, pass === 'plaque' ? 45 : lumenHu, 'set')
      }
    }
  }

  // calcium: Gaussian-profile blobs so each has a definite peak and soft edges
  const blobs = [
    ...PLAQUE_POS.map((p) => ({ x: p.x, y: p.y, z: p.z, rx: p.r, ry: p.r, rz: p.r, peak: p.peak })),
    ...DISTRACTORS,
  ]
  for (const b of blobs) {
    const dz = (z - b.z) / b.rz
    if (Math.abs(dz) >= 1.4) continue
    const reach = Math.max(b.rx, b.ry) * 1.4
    const i0 = Math.max(0, Math.floor((b.x - reach) / px))
    const i1 = Math.min(n - 1, Math.ceil((b.x + reach) / px))
    const j0 = Math.max(0, Math.floor((b.y - reach) / px))
    const j1 = Math.min(n - 1, Math.ceil((b.y + reach) / px))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = ((i + 0.5) * px - b.x) / b.rx
        const dy = ((j + 0.5) * px - b.y) / b.ry
        const q = dx * dx + dy * dy + dz * dz
        if (q > 1.96) continue
        // calcium reads far brighter than iodinated lumen on contrast CT (blooming)
        const v = (contrast ? b.peak + 400 : b.peak) * Math.exp(-q * 0.9)
        const k = j * n + i
        if (v > out[k]) out[k] = v
      }
    }
  }
}

function blur3(buf, n) {
  const tmp = new Float32Array(buf.length)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const l = buf[j * n + Math.max(0, i - 1)]
      const r = buf[j * n + Math.min(n - 1, i + 1)]
      tmp[j * n + i] = 0.25 * l + 0.5 * buf[j * n + i] + 0.25 * r
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = tmp[Math.max(0, j - 1) * n + i]
      const d = tmp[Math.min(n - 1, j + 1) * n + i]
      buf[j * n + i] = 0.25 * u + 0.5 * tmp[j * n + i] + 0.25 * d
    }
  }
}

/**
 * One reconstructed slice: the slab [z - thickness/2, z + thickness/2] averaged
 * from 1 mm sub-planes (partial-volume averaging), blurred, then noised.
 */
export function renderSlab(z, thickness, { n = MATRIX, contrast = false, noise = 14, seed = 1 } = {}) {
  const subs = Math.max(1, Math.round(thickness))
  const acc = new Float32Array(n * n)
  const plane = new Float32Array(n * n)
  for (let s = 0; s < subs; s++) {
    const zz = z - thickness / 2 + (s + 0.5) * (thickness / subs)
    evaluatePlane(plane, n, zz, contrast)
    stampVessels(plane, n, zz, contrast)
    for (let k = 0; k < acc.length; k++) acc[k] += plane[k] / subs
  }
  blur3(acc, n)
  const zi = Math.round(z * 10)
  for (let k = 0; k < acc.length; k++) {
    if (acc[k] > -990) acc[k] += noise * gauss(k, zi, seed)
  }
  return acc
}

/* -------------------------------------------------------------- the series */

/**
 * The reconstructions a cardiac CT study carries. `dicom` mirrors the tags the
 * CAC validator reads from a real series.
 */
export const CARDIAC_SERIES = [
  {
    key: 'cac',
    name: 'Ca Score 3mm · gated',
    z0: 30, slices: 40, thickness: 3, increment: 3, contrast: false, noise: 12,
    dicom: {
      Modality: 'CT', Manufacturer: 'Asvanta phantom', ManufacturerModelName: 'Analytic cardiac v1',
      SeriesDescription: 'CaSc 3.0 Qr36 75%', SliceThickness: 3, SpacingBetweenSlices: 3, PixelSpacing: [PIXEL_MM, PIXEL_MM],
      KVP: 120, ContrastBolusAgent: null, CardiacSynchronizationTechnique: 'PROSPECTIVE', NominalPercentageOfCardiacPhase: 75,
      ConvolutionKernel: 'Qr36', RescaleSlope: 1, RescaleIntercept: -1024, ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      HeartRate: 61,
    },
  },
  {
    key: 'cta',
    name: 'CCTA 1mm · gated · contrast',
    z0: 34, slices: 110, thickness: 1, increment: 1, contrast: true, noise: 18,
    dicom: {
      Modality: 'CT', Manufacturer: 'Asvanta phantom', ManufacturerModelName: 'Analytic cardiac v1',
      SeriesDescription: 'CCTA 1.0 Bv40 75%', SliceThickness: 1, SpacingBetweenSlices: 1, PixelSpacing: [PIXEL_MM, PIXEL_MM],
      KVP: 100, ContrastBolusAgent: 'Iohexol 350', CardiacSynchronizationTechnique: 'RETROSPECTIVE', NominalPercentageOfCardiacPhase: 75,
      ConvolutionKernel: 'Bv40', RescaleSlope: 1, RescaleIntercept: -1024, ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      HeartRate: 58,
    },
  },
  {
    key: 'survey',
    name: 'Ax Thorax 5mm · non-gated',
    z0: 22, slices: 26, thickness: 5, increment: 5, contrast: false, noise: 10,
    dicom: {
      Modality: 'CT', Manufacturer: 'Asvanta phantom', ManufacturerModelName: 'Analytic cardiac v1',
      SeriesDescription: 'Thorax 5.0 Br40', SliceThickness: 5, SpacingBetweenSlices: 5, PixelSpacing: [PIXEL_MM, PIXEL_MM],
      KVP: 120, ContrastBolusAgent: null, CardiacSynchronizationTechnique: null, NominalPercentageOfCardiacPhase: null,
      ConvolutionKernel: 'Br40', RescaleSlope: 1, RescaleIntercept: -1024, ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      HeartRate: null,
    },
  },
]

/**
 * Stored pixel values for slice `k` of a series, as a scanner would write them:
 * unsigned integers that only become HU after RescaleSlope/RescaleIntercept.
 */
export function storedSlice(series, k, n = MATRIX) {
  const z = series.z0 + k * series.increment
  const hu = renderSlab(z, series.thickness, { n, contrast: series.contrast, noise: series.noise, seed: series.key.length * 97 })
  const raw = new Uint16Array(n * n)
  const { RescaleSlope: m, RescaleIntercept: b } = series.dicom
  for (let i = 0; i < hu.length; i++) raw[i] = Math.max(0, Math.min(65535, Math.round((hu[i] - b) / m)))
  return raw
}

/* ------------------------------------------------- anatomy "model" outputs */

/*
 * Production replaces everything below with a segmentation model (heart, aorta,
 * valves) and coronary centerline extraction. Here they are deliberately imperfect
 * so the radiologist review step has real corrections to make:
 *   - the heart region stops ~8 mm short of the inferior wall, so a distal RCA
 *     plaque is excluded as "outside heart"
 *   - the LM atlas centerline overshoots into the proximal LAD and the atlas LAD
 *     starts late, so a plaque right at the bifurcation is assigned to LM
 *   - the mitral annulus is not modelled, so its calcification lands on the LCX
 */

/** Heart-region test in world mm. */
export function inHeartRegion(x, y, z) {
  if (z > HEART.cz + 12 && y > HEART.cy + 20) return false // localisation misses the inferior wall / crux
  const s = zScale({ ...HEART, rz: HEART.rz + 6 }, z)
  if (s <= 0) return false
  return ellD(x, y, HEART.cx, HEART.cy, (HEART.rx + 8) * s, (HEART.ry + 8) * s, HEART.rot) < 1
}

/** Aortic root / valve plane: calcium here is valvular, not coronary. */
export function inAorticRoot(x, y, z) {
  return Math.hypot(x - AORTA_ASC.cx, y - AORTA_ASC.cy - 4) < AORTA_ASC.r - 1 && z > 48 && z < 62
}

/** Centerlines as the vessel-assignment step sees them. */
export const ATLAS_CENTERLINES = {
  ...CENTERLINES,
  LM: [...CENTERLINES.LM, [147, 88, 60, 2.0]],
  LAD: CENTERLINES.LAD.slice(1),
}

/** The automatically proposed centerline for CPR: the atlas, a few mm off in places. */
export function proposedCenterline(vessel) {
  return CENTERLINES[vessel].map(([x, y, z, r], i, arr) => {
    if (i === 0 || i === arr.length - 1) return [x, y, z, r]
    const jitter = (hash(i, vessel.length, 5) - 0.5) * 5
    return [x + jitter, y - jitter * 0.6, z, r]
  })
}

/** The anatomy provider the CAC pipeline calls for this phantom. */
export const PHANTOM_ANATOMY = {
  inHeart: inHeartRegion,
  nonCoronary: (x, y, z) => (inAorticRoot(x, y, z) ? 'Aortic valve / root' : null),
  centerlines: ATLAS_CENTERLINES,
}
