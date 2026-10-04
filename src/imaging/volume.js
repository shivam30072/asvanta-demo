/**
 * Series → 3D volume → reconstructed planes.
 *
 * A volume is { hu: Int16Array, dims: [nx, ny, nz], spacing: [sx, sy, sz], z0, rescale }.
 * Voxel (i, j, k) sits at world mm x = (i+0.5)·sx, y = (j+0.5)·sy, z = z0 + k·sz.
 *
 * This is what Cornerstone3D/VTK do on the GPU in production; here it runs on the
 * CPU over the synthetic series so MPR and CPR work without a DICOM backend.
 */
import { sliceData } from '../viewer/synth'
import { MATRIX, PIXEL_MM, storedSlice } from './phantom'
import { loadDicomVolume } from '../live/dicomweb'

const cache = new Map()

const LEGACY_N = 160
const LEGACY_MAX_SLICES = 120

const tick = () => new Promise((r) => setTimeout(r, 0))

const pending = new Map()
const listeners = new Map()

/** Build (or fetch from cache) the volume for a viewer series. Concurrent callers share one build. */
export function loadVolume(series, onProgress = () => {}) {
  if (cache.has(series.id)) return Promise.resolve(cache.get(series.id))
  if (!listeners.has(series.id)) listeners.set(series.id, new Set())
  listeners.get(series.id).add(onProgress)
  if (!pending.has(series.id)) {
    const report = (p) => listeners.get(series.id)?.forEach((fn) => fn(p))
    pending.set(
      series.id,
      buildVolume(series, report).finally(() => {
        pending.delete(series.id)
        listeners.delete(series.id)
      })
    )
  }
  return pending.get(series.id)
}

async function buildVolume(series, onProgress) {
  if (series.dicomweb) {
    const vol = await loadDicomVolume(series.dicomweb, onProgress)
    cache.set(series.id, vol)
    return vol
  }

  let vol
  if (series.phantom) {
    const ph = series.phantom
    const n = MATRIX
    const nz = ph.slices
    const hu = new Int16Array(n * n * nz)
    const { RescaleSlope: m, RescaleIntercept: b } = ph.dicom
    for (let k = 0; k < nz; k++) {
      // stored values → Hounsfield units, exactly the step a DICOM loader performs
      const raw = storedSlice(ph, k, n)
      const off = k * n * n
      for (let i = 0; i < raw.length; i++) hu[off + i] = raw[i] * m + b
      if (k % 4 === 3) {
        onProgress((k + 1) / nz)
        await tick()
      }
    }
    vol = { hu, dims: [n, n, nz], spacing: [PIXEL_MM, PIXEL_MM, ph.increment], z0: ph.z0, rescale: { slope: m, intercept: b } }
  } else {
    // procedural series: stack its slices into a coarser volume
    const n = LEGACY_N
    const nz = Math.min(series.count, LEGACY_MAX_SLICES)
    const hu = new Int16Array(n * n * nz)
    for (let k = 0; k < nz; k++) {
      const src = Math.round((k * (series.count - 1)) / Math.max(1, nz - 1))
      const buf = sliceData(series.anatomy, series.seed, src, series.count, n, series.mri)
      hu.set(Array.from(buf, (v) => Math.round(v)), k * n * n)
      if (k % 6 === 5) {
        onProgress((k + 1) / nz)
        await tick()
      }
    }
    const px = (series.pixelSpacing * 384) / n
    const sz = ((series.thickness || 1) * series.count) / nz
    vol = { hu, dims: [n, n, nz], spacing: [px, px, sz], z0: 0, rescale: null }
  }
  onProgress(1)
  cache.set(series.id, vol)
  return vol
}

export const cachedVolume = (series) => cache.get(series.id) || null

/* ---------------------------------------------------------------- sampling */

export const worldToVoxel = (vol, [x, y, z]) => [x / vol.spacing[0] - 0.5, y / vol.spacing[1] - 0.5, (z - vol.z0) / vol.spacing[2]]
export const voxelToWorld = (vol, [i, j, k]) => [(i + 0.5) * vol.spacing[0], (j + 0.5) * vol.spacing[1], vol.z0 + k * vol.spacing[2]]

export const extent = (vol) => ({
  x: [0, vol.dims[0] * vol.spacing[0]],
  y: [0, vol.dims[1] * vol.spacing[1]],
  z: [vol.z0, vol.z0 + (vol.dims[2] - 1) * vol.spacing[2]],
})

/** Trilinear HU at a world point; air outside the volume. */
export function sample(vol, x, y, z) {
  const [nx, ny, nz] = vol.dims
  const fi = x / vol.spacing[0] - 0.5
  const fj = y / vol.spacing[1] - 0.5
  const fk = (z - vol.z0) / vol.spacing[2]
  if (fi < 0 || fj < 0 || fk < 0 || fi > nx - 1 || fj > ny - 1 || fk > nz - 1) return -1000
  const i = Math.min(nx - 2, Math.floor(fi))
  const j = Math.min(ny - 2, Math.floor(fj))
  const k = Math.min(Math.max(0, nz - 2), Math.floor(fk))
  const a = fi - i
  const b = fj - j
  const c = nz > 1 ? fk - k : 0
  const plane = nx * ny
  const h = vol.hu
  const o = k * plane + j * nx + i
  const k1 = nz > 1 ? plane : 0
  const v00 = h[o] * (1 - a) + h[o + 1] * a
  const v10 = h[o + nx] * (1 - a) + h[o + nx + 1] * a
  const v01 = h[o + k1] * (1 - a) + h[o + k1 + 1] * a
  const v11 = h[o + k1 + nx] * (1 - a) + h[o + k1 + nx + 1] * a
  return (v00 * (1 - b) + v10 * b) * (1 - c) + (v01 * (1 - b) + v11 * b) * c
}

/* ------------------------------------------------------------------ planes */

/**
 * A reconstructed plane through the volume.
 *
 * `plane` is axial | coronal | sagittal | oblique. `center` is a world point the
 * plane passes through; for oblique, `angle` (deg) rotates a sagittal-like plane
 * about the cranio-caudal axis and `tilt` (deg) tips it toward axial.
 * `slabMm` > 0 renders a maximum-intensity slab of that thickness.
 *
 * Returns { data, w, h, mmX, mmY, origin, axisU, axisV, normal } where pixel
 * (c, r) maps to world origin + c·mmX·axisU + r·mmY·axisV.
 */
export function reslice(vol, plane, center, { angle = 0, tilt = 0, slabMm = 0, resolution } = {}) {
  const ex = extent(vol)
  const [sx, sy, sz] = vol.spacing
  let axisU
  let axisV
  let w
  let h
  let mmX
  let mmY
  let origin

  if (plane === 'axial') {
    axisU = [1, 0, 0]
    axisV = [0, 1, 0]
    ;[w, h, mmX, mmY] = [vol.dims[0], vol.dims[1], sx, sy]
    origin = [sx / 2, sy / 2, center[2]]
  } else if (plane === 'coronal') {
    axisU = [1, 0, 0]
    axisV = [0, 0, 1]
    mmX = sx
    mmY = Math.min(sx, sz)
    w = vol.dims[0]
    h = Math.max(1, Math.round((ex.z[1] - ex.z[0]) / mmY) + 1)
    origin = [sx / 2, center[1], ex.z[0]]
  } else if (plane === 'sagittal') {
    axisU = [0, 1, 0]
    axisV = [0, 0, 1]
    mmX = sy
    mmY = Math.min(sy, sz)
    w = vol.dims[1]
    h = Math.max(1, Math.round((ex.z[1] - ex.z[0]) / mmY) + 1)
    origin = [center[0], sy / 2, ex.z[0]]
  } else {
    // oblique: start from coronal (u = x, v = z), rotate u about z, then tilt v
    const a = (angle * Math.PI) / 180
    const t = (tilt * Math.PI) / 180
    axisU = [Math.cos(a), Math.sin(a), 0]
    const n0 = [-Math.sin(a), Math.cos(a), 0] // normal before tilt
    axisV = [n0[0] * Math.sin(t), n0[1] * Math.sin(t), Math.cos(t)]
    const size = Math.max(ex.x[1], ex.y[1])
    mmX = resolution || sx
    mmY = resolution || Math.min(sx, sz)
    w = Math.round(size / mmX)
    h = Math.round(size / mmY)
    origin = center.map((c, d) => c - axisU[d] * (w / 2) * mmX - axisV[d] * (h / 2) * mmY)
  }

  const normal = normalize(crossV(axisU, axisV))
  const steps = slabMm > 0 ? Math.max(1, Math.round(slabMm / Math.min(sx, sz))) : 1
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const px = origin[0] + c * mmX * axisU[0] + r * mmY * axisV[0]
      const py = origin[1] + c * mmX * axisU[1] + r * mmY * axisV[1]
      const pz = origin[2] + c * mmX * axisU[2] + r * mmY * axisV[2]
      let v = -Infinity
      for (let s = 0; s < steps; s++) {
        const o = steps === 1 ? 0 : (s / (steps - 1) - 0.5) * slabMm
        const val = sample(vol, px + normal[0] * o, py + normal[1] * o, pz + normal[2] * o)
        if (val > v) v = val
      }
      data[r * w + c] = v
    }
  }
  return { data, w, h, mmX, mmY, origin, axisU, axisV, normal }
}

/** Project a world point into a resliced plane's pixel coordinates (and signed distance off-plane). */
export function projectToPlane(img, p) {
  const d = [p[0] - img.origin[0], p[1] - img.origin[1], p[2] - img.origin[2]]
  return {
    c: dot(d, img.axisU) / img.mmX,
    r: dot(d, img.axisV) / img.mmY,
    off: dot(d, img.normal),
  }
}

/** World point for a pixel of a resliced plane. */
export const planeToWorld = (img, c, r) => img.origin.map((o, d) => o + c * img.mmX * img.axisU[d] + r * img.mmY * img.axisV[d])

/* -------------------------------------------------------------------- CPR */

/**
 * Straightened curved planar reconstruction along a sampled centerline.
 * Rows follow the vessel (one per `step` mm of arc length); columns run across it
 * along a direction rotated `angle` degrees about the local tangent.
 * Uses a rotation-minimising frame so the image does not twist along the vessel.
 */
export function straightenedCpr(vol, samples, { angle = 0, halfWidthMm = 18, step = 0.4 } = {}) {
  const frames = transportFrames(samples)
  const total = frames.length ? frames[frames.length - 1].s : 0
  const h = Math.max(2, Math.round(total / step))
  const w = Math.round((2 * halfWidthMm) / step)
  const data = new Float32Array(w * h)
  const a = (angle * Math.PI) / 180
  const rows = []
  let fi = 0
  for (let r = 0; r < h; r++) {
    const s = (r / (h - 1)) * total
    while (fi < frames.length - 2 && frames[fi + 1].s < s) fi++
    const f0 = frames[fi]
    const f1 = frames[Math.min(frames.length - 1, fi + 1)]
    const t = (s - f0.s) / Math.max(1e-6, f1.s - f0.s)
    const p = f0.p.map((v, d) => v + (f1.p[d] - v) * t)
    const dir = f0.u.map((u, d) => u * Math.cos(a) + f0.v[d] * Math.sin(a))
    rows.push({ p, dir, tan: f0.tan, u: f0.u, v: f0.v, s })
    for (let c = 0; c < w; c++) {
      const o = (c - (w - 1) / 2) * step
      data[r * w + c] = sample(vol, p[0] + dir[0] * o, p[1] + dir[1] * o, p[2] + dir[2] * o)
    }
  }
  return { data, w, h, mmX: step, mmY: step, rows, length: total }
}

/** Cross-section perpendicular to the vessel at one CPR row. */
export function crossSection(vol, row, { halfWidthMm = 8, step = 0.2 } = {}) {
  const w = Math.round((2 * halfWidthMm) / step)
  const data = new Float32Array(w * w)
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < w; c++) {
      const ou = (c - (w - 1) / 2) * step
      const ov = (r - (w - 1) / 2) * step
      data[r * w + c] = sample(
        vol,
        row.p[0] + row.u[0] * ou + row.v[0] * ov,
        row.p[1] + row.u[1] * ou + row.v[1] * ov,
        row.p[2] + row.u[2] * ou + row.v[2] * ov
      )
    }
  }
  return { data, w, h: w, mmX: step, mmY: step }
}

/**
 * Lumen area at a cross-section: contrast-filled pixels (between `lo` and `hi` HU,
 * so calcium is not counted as lumen) connected to the centre.
 * Returns area in mm² and the equivalent circular diameter.
 */
export function lumenArea(xs, { lo = 200, hi = 650 } = {}) {
  const { data, w, mmX } = xs
  const inLumen = (k) => data[k] >= lo && data[k] <= hi
  const c = Math.floor(w / 2)
  // start from the brightest in-range pixel near the centre: the centerline may be slightly off
  let start = -1
  let best = -Infinity
  for (let r = c - 3; r <= c + 3; r++) {
    for (let q = c - 3; q <= c + 3; q++) {
      const k = r * w + q
      if (inLumen(k) && data[k] > best) {
        best = data[k]
        start = k
      }
    }
  }
  if (start < 0) return { areaMm2: 0, diameterMm: 0 }
  const seen = new Uint8Array(data.length)
  const stack = [start]
  seen[start] = 1
  let count = 0
  while (stack.length) {
    const k = stack.pop()
    count++
    const x = k % w
    const y = (k - x) / w
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= w) continue
      const q = ny * w + nx
      if (!seen[q] && inLumen(q)) {
        seen[q] = 1
        stack.push(q)
      }
    }
  }
  const areaMm2 = count * mmX * mmX
  return { areaMm2, diameterMm: 2 * Math.sqrt(areaMm2 / Math.PI) }
}

/** Rotation-minimising (parallel-transport) frames along a polyline. */
function transportFrames(samples) {
  if (samples.length < 2) return []
  const out = []
  let s = 0
  let u = null
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)]
    const b = samples[Math.min(samples.length - 1, i + 1)]
    const tan = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    if (i > 0) s += Math.hypot(...samples[i].slice(0, 3).map((v, d) => v - samples[i - 1][d]))
    if (!u) {
      const ref = Math.abs(tan[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]
      u = normalize(crossV(tan, ref))
    } else {
      // remove the tangent component from the previous u
      const d = dot(u, tan)
      u = normalize(u.map((v, k) => v - d * tan[k]))
    }
    const v = crossV(tan, u)
    out.push({ p: samples[i].slice(0, 3), tan, u, v, s })
  }
  return out
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (a) => {
  const l = Math.hypot(...a) || 1
  return a.map((v) => v / l)
}
