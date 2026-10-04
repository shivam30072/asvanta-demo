/**
 * Deterministic Agatston engine — the browser twin of engine/asvanta_cac/agatston.py.
 * Both are held to the same hand-computed cases in reference/cac-cases.json.
 *
 * A volume is { hu: Float32Array, dims: [nx, ny, nz], spacing: [sx, sy, sz] } with
 * voxel index z*nx*ny + y*nx + x and sz the slice increment in mm.
 *
 * Rules:
 *   - calcium voxel: HU >= threshold (130)
 *   - per axial slice, 8-connected regions; a region counts if its area >= 1 mm²
 *   - factor from the region's peak HU: 130–199 → 1, 200–299 → 2, 300–399 → 3, ≥400 → 4
 *   - region score = area × factor × (slice increment / 3 mm)
 *   - regions on adjacent slices sharing a pixel are one lesion
 * Nothing is rounded here; rounding is for display only.
 */

export const THRESHOLD_HU = 130
export const MIN_AREA_MM2 = 1
const EPS = 1e-9

export const densityFactor = (peakHu) => (peakHu >= 400 ? 4 : peakHu >= 300 ? 3 : peakHu >= 200 ? 2 : peakHu >= 130 ? 1 : 0)

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

/**
 * Label the 8-connected regions of one slice. `member(i)` decides which in-plane
 * pixels take part. Returns arrays of in-plane pixel indices.
 */
function labelSlice(nx, ny, member) {
  const seen = new Uint8Array(nx * ny)
  const stack = new Int32Array(nx * ny)
  const out = []
  for (let start = 0; start < nx * ny; start++) {
    if (seen[start] || !member(start)) continue
    const pixels = []
    let top = 0
    stack[top++] = start
    seen[start] = 1
    while (top) {
      const p = stack[--top]
      pixels.push(p)
      const x = p % nx
      const y = (p - x) / nx
      for (const [dx, dy] of NEIGHBOURS) {
        const qx = x + dx
        const qy = y + dy
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue
        const q = qy * nx + qx
        if (!seen[q] && member(q)) {
          seen[q] = 1
          stack[top++] = q
        }
      }
    }
    out.push(pixels)
  }
  return out
}

function scoreRegion(vol, z, pixels, minAreaMm2) {
  const [nx, ny] = vol.dims
  const [sx, sy, sz] = vol.spacing
  const base = z * nx * ny
  const areaMm2 = pixels.length * sx * sy
  if (areaMm2 + EPS < minAreaMm2) return null
  let peakHu = -Infinity
  for (const p of pixels) if (vol.hu[base + p] > peakHu) peakHu = vol.hu[base + p]
  const factor = densityFactor(peakHu)
  return { z, pixels, areaMm2, peakHu, factor, score: areaMm2 * factor * (sz / 3) }
}

/** Group regions into 3D lesions: adjacent slices that share a pixel are one lesion. */
function linkRegions(vol, regions) {
  const [nx, ny, nz] = vol.dims
  const parent = regions.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const bySlice = Array.from({ length: nz }, () => [])
  regions.forEach((r, i) => bySlice[r.z].push(i))

  let prev = new Int32Array(nx * ny).fill(-1)
  let cur = new Int32Array(nx * ny)
  for (let z = 0; z < nz; z++) {
    cur.fill(-1)
    for (const i of bySlice[z]) {
      for (const p of regions[i].pixels) {
        cur[p] = i
        const j = prev[p]
        if (j >= 0) parent[find(i)] = find(j)
      }
    }
    ;[prev, cur] = [cur, prev]
  }

  const groups = new Map()
  regions.forEach((r, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(r)
  })
  return [...groups.values()]
}

function summarise(vol, regs) {
  const [nx, ny] = vol.dims
  const [sx, sy, sz] = vol.spacing
  const plane = nx * ny
  const voxels = []
  let cx = 0
  let cy = 0
  let cz = 0
  for (const r of regs) {
    for (const p of r.pixels) {
      voxels.push(r.z * plane + p)
      cx += p % nx
      cy += Math.floor(p / nx)
      cz += r.z
    }
  }
  const n = voxels.length || 1
  return {
    regions: regs,
    voxels,
    score: regs.reduce((a, r) => a + r.score, 0),
    peakHu: regs.reduce((a, r) => Math.max(a, r.peakHu), -Infinity),
    areaMm2: regs.reduce((a, r) => a + r.areaMm2, 0),
    volumeMm3: voxels.length * sx * sy * sz,
    zRange: regs.length ? [Math.min(...regs.map((r) => r.z)), Math.max(...regs.map((r) => r.z))] : null,
    centroid: [cx / n, cy / n, cz / n], // voxel coordinates
  }
}

/** Score a whole volume. */
export function agatston(vol, { threshold = THRESHOLD_HU, minAreaMm2 = MIN_AREA_MM2 } = {}) {
  const [nx, ny, nz] = vol.dims
  const plane = nx * ny
  const regions = []
  for (let z = 0; z < nz; z++) {
    const base = z * plane
    for (const pixels of labelSlice(nx, ny, (p) => vol.hu[base + p] >= threshold)) {
      const r = scoreRegion(vol, z, pixels, minAreaMm2)
      if (r) regions.push(r)
    }
  }
  const lesions = linkRegions(vol, regions)
    .map((regs) => summarise(vol, regs))
    .sort((a, b) => a.zRange[0] - b.zRange[0] || a.centroid[1] - b.centroid[1])
  return {
    regions,
    lesions,
    total: lesions.reduce((a, l) => a + l.score, 0),
    volumeMm3: lesions.reduce((a, l) => a + l.volumeMm3, 0),
  }
}

/**
 * Re-score an arbitrary voxel set (a lesion after the radiologist erased part of it,
 * or one they added). Same rules: only voxels still ≥ threshold, regions per slice.
 */
export function scoreVoxels(vol, voxels, { threshold = THRESHOLD_HU, minAreaMm2 = MIN_AREA_MM2 } = {}) {
  const [nx, ny] = vol.dims
  const plane = nx * ny
  const bySlice = new Map()
  for (const v of voxels) {
    if (vol.hu[v] < threshold) continue
    const z = Math.floor(v / plane)
    if (!bySlice.has(z)) bySlice.set(z, new Set())
    bySlice.get(z).add(v - z * plane)
  }
  const regs = []
  for (const [z, set] of [...bySlice.entries()].sort((a, b) => a[0] - b[0])) {
    for (const pixels of labelSlice(nx, ny, (p) => set.has(p))) {
      const r = scoreRegion(vol, z, pixels, minAreaMm2)
      if (r) regs.push(r)
    }
  }
  return summarise(vol, regs)
}

/**
 * Grow a lesion from a clicked voxel: 8-connected in-plane, and straight up/down
 * to the same pixel on the next slice — the same connectivity lesions are linked by.
 */
export function regionGrow(vol, seed, { threshold = THRESHOLD_HU, maxVoxels = 20000 } = {}) {
  const [nx, ny, nz] = vol.dims
  const plane = nx * ny
  if (!(vol.hu[seed] >= threshold)) return []
  const seen = new Set([seed])
  const queue = [seed]
  for (let qi = 0; qi < queue.length && queue.length < maxVoxels; qi++) {
    const v = queue[qi]
    const z = Math.floor(v / plane)
    const p = v - z * plane
    const x = p % nx
    const y = (p - x) / nx
    const next = []
    for (const [dx, dy] of NEIGHBOURS) {
      const qx = x + dx
      const qy = y + dy
      if (qx >= 0 && qy >= 0 && qx < nx && qy < ny) next.push(z * plane + qy * nx + qx)
    }
    if (z > 0) next.push(v - plane)
    if (z < nz - 1) next.push(v + plane)
    for (const q of next) {
      if (!seen.has(q) && vol.hu[q] >= threshold) {
        seen.add(q)
        queue.push(q)
      }
    }
  }
  return queue.sort((a, b) => a - b)
}
