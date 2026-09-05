/**
 * Procedural stand-in for a DICOM pixel array.
 *
 * Each generator fills a Float32Array of stored values for one slice:
 *   CT-like studies use a pseudo-Hounsfield scale (-1000 air … ~1200 cortical bone),
 *   everything else uses an arbitrary 0…1000 signal scale.
 * The viewer applies window/level on top, exactly as it would to real pixel data,
 * so the windowing controls behave the way a radiologist expects.
 *
 * Realism comes from three passes: structure, then a small blur for partial-volume
 * averaging, then per-pixel noise. Flat regions without noise read as cartoons.
 */

/* ------------------------------------------------------------- primitives */

const hash = (x, y, s) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1103515245)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t) => t * t * (3 - 2 * t)

const valueNoise = (x, y, s) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = smooth(x - xi)
  const fy = smooth(y - yi)
  const a = hash(xi, yi, s)
  const b = hash(xi + 1, yi, s)
  const c = hash(xi, yi + 1, s)
  const d = hash(xi + 1, yi + 1, s)
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
}

const fbm = (x, y, s, oct = 3) => {
  let v = 0
  let amp = 0.5
  let f = 1
  for (let o = 0; o < oct; o++) {
    v += amp * valueNoise(x * f, y * f, s + o * 13)
    amp *= 0.5
    f *= 2.03
  }
  return v // 0…~1
}

/** Normalised ellipse distance, optionally rotated. <1 inside. */
const ell = (x, y, cx, cy, rx, ry, rot = 0) => {
  let dx = x - cx
  let dy = y - cy
  if (rot) {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const nx = dx * c + dy * s
    dy = -dx * s + dy * c
    dx = nx
  }
  dx /= rx
  dy /= ry
  return Math.sqrt(dx * dx + dy * dy)
}

/** 1 well inside the shape, 0 well outside, soft over `edge` in distance units. */
const inside = (d, edge = 0.05) => {
  if (d <= 1 - edge) return 1
  if (d >= 1 + edge) return 0
  return smooth((1 + edge - d) / (2 * edge))
}

/** Superellipse distance, exponent 4 — a rounded rectangle. <1 inside.
 *  Fixed at 4 so it reduces to squares and square roots; Math.pow here is far too slow. */
const supe = (x, y, cx, cy, rx, ry, _n, rot = 0) => {
  let dx = x - cx
  let dy = y - cy
  if (rot) {
    const c = Math.cos(rot)
    const sn = Math.sin(rot)
    const nx = dx * c + dy * sn
    dy = -dx * sn + dy * c
    dx = nx
  }
  const a = (dx * dx) / (rx * rx)
  const b = (dy * dy) / (ry * ry)
  return Math.sqrt(Math.sqrt(a * a + b * b))
}

/** Record a vessel segment with a tight bounding box, so most are rejected cheaply. */
const pushBranch = (list, ax, ay, bx, by, w) => {
  const reach = w * 2.4
  list.push([ax, ay, bx, by, w, Math.min(ax, bx) - reach, Math.max(ax, bx) + reach, Math.min(ay, by) - reach, Math.max(ay, by) + reach])
}

/** Distance from point to a line segment, in image units. */
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/* ------------------------------------------------------------ post passes */

/** Separable 3-tap blur — stands in for partial-volume averaging. */
function blur(buf, N, tmp) {
  for (let j = 0; j < N; j++) {
    const r = j * N
    for (let i = 0; i < N; i++) {
      const a = buf[r + (i > 0 ? i - 1 : 0)]
      const b = buf[r + i]
      const c = buf[r + (i < N - 1 ? i + 1 : N - 1)]
      tmp[r + i] = a * 0.25 + b * 0.5 + c * 0.25
    }
  }
  for (let j = 0; j < N; j++) {
    const up = (j > 0 ? j - 1 : 0) * N
    const dn = (j < N - 1 ? j + 1 : N - 1) * N
    const r = j * N
    for (let i = 0; i < N; i++) {
      buf[r + i] = tmp[up + i] * 0.25 + tmp[r + i] * 0.5 + tmp[dn + i] * 0.25
    }
  }
}

/** Quantum/electronic noise. Without it every flat region looks synthetic. */
function addNoise(buf, N, sigma, seed) {
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      // Box–Muller. u must stay strictly inside (0,1): at u=1 the log turns
      // positive and the sqrt yields NaN, which then poisons the pixel.
      const u = hash(i * 1.7, j * 2.3, seed) * 0.9999998 + 1e-7
      const v = hash(i * 3.1 + 11, j * 1.3 + 7, seed)
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v)
      buf[j * N + i] += g * sigma
    }
  }
}

/* ---------------------------------------------------------------- anatomy */

const AIR = -1000

function head({ buf, N, t, mri, seed }) {
  // stack runs vertex → skull base; the head narrows at both ends
  const prof = Math.sin(Math.PI * Math.min(1, Math.max(0.04, t * 0.92 + 0.08)))
  const scale = 0.62 + 0.38 * prof
  const cx = 0.5
  const cy = 0.5
  const rx = 0.325 * scale
  const ry = 0.385 * scale
  const ventOpen = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.15) / 0.7))))

  const scalpV = mri ? 640 : 50
  const boneV = mri ? 80 : 1050
  const diploeV = mri ? 260 : 380
  const greyV = mri ? 470 : 38
  const whiteV = mri ? 610 : 27
  const csfV = mri ? 95 : 8

  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      const d = ell(x, y, cx, cy, rx, ry)
      let v = AIR

      const body = inside(d, 0.012)
      if (body > 0) {
        // one noise sample per pixel, reused for every tissue: sampling fbm
        // separately per structure is the single biggest cost in here
        const tex = fbm(x * 30, y * 30, seed)
        // scalp → outer table → diploë → inner table → brain
        let tissue
        if (d > 0.955) tissue = scalpV
        else if (d > 0.925) tissue = boneV
        else if (d > 0.895) tissue = diploeV
        else if (d > 0.865) tissue = boneV
        else {
          const g = tex
          // white matter core, grey ribbon following the cortex
          const wm = inside(ell(x, y, cx, cy + 0.012, rx * 0.66, ry * 0.66), 0.10)
          tissue = whiteV * wm + greyV * (1 - wm) + (g - 0.5) * (mri ? 70 : 6)

          const vs = 0.105 * ventOpen
          if (vs > 0.012) {
            // frontal horns: narrow, angled, separated by the septum
            const vl = inside(ell(x, y, cx - 0.042, cy - 0.020, vs * 0.30, vs * 0.95, 0.30), 0.30)
            const vr = inside(ell(x, y, cx + 0.042, cy - 0.020, vs * 0.30, vs * 0.95, -0.30), 0.30)
            // occipital horns, only deep in the stack
            const deep = Math.max(0, (t - 0.45) / 0.4)
            const ol = inside(ell(x, y, cx - 0.055, cy + 0.075, vs * 0.24, vs * 0.55, -0.35), 0.35) * deep
            const or_ = inside(ell(x, y, cx + 0.055, cy + 0.075, vs * 0.24, vs * 0.55, 0.35), 0.35) * deep
            const vent = Math.min(1, Math.max(Math.max(vl, vr), Math.max(ol, or_)))
            tissue = tissue * (1 - vent) + csfV * vent

            // third ventricle: a thin midline slit through the mid slices
            const third = inside(ell(x, y, cx, cy + 0.012, 0.004, vs * 0.45), 0.5) * ventOpen
            tissue = tissue * (1 - third) + csfV * third
          }
          // falx and interhemispheric fissure
          const falx = inside(ell(x, y, cx, cy, 0.0035, ry * 0.8), 0.5)
          if (d < 0.84) tissue = tissue * (1 - falx) + (mri ? 190 : 46) * falx
          // sulcal CSF near the surface
          if (d > 0.72 && d < 0.865) {
            const a = Math.atan2(y - cy, x - cx)
            const sulci = Math.max(0, Math.sin(a * 29 + t * 5) - 0.80) * 5 * Math.min(1, (d - 0.72) / 0.06)
            tissue = tissue * (1 - sulci * 0.45) + csfV * sulci * 0.45
          }
        }
        v = AIR * (1 - body) + tissue * body
      }
      buf[j * N + i] = v
    }
  }
}

function chest({ buf, N, t, seed }) {
  const cx = 0.5
  const cy = 0.5
  const rx = 0.395
  const ry = 0.295
  const heart = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.15) / 0.8))) // largest mid-stack

  // pulmonary vessels: a tapering tree per lung, growing outward from each hilum
  const branches = []
  for (const side of [-1, 1]) {
    const hx = cx + side * 0.085
    const hy = cy + 0.012
    const outward = side < 0 ? Math.PI : 0 // point away from the mediastinum
    for (let b = 0; b < 6; b++) {
      const ang = outward + (b / 5 - 0.5) * 1.75 + (hash(b, side + 4, seed) - 0.5) * 0.25
      const len = 0.055 + hash(b, side + 9, seed) * 0.05
      const ex = hx + Math.cos(ang) * len
      const ey = hy + Math.sin(ang) * len
      pushBranch(branches, hx, hy, ex, ey, 0.0042)
      // two finer divisions off each trunk
      for (const k of [-1, 1]) {
        const a2 = ang + k * (0.30 + hash(b, k + 20, seed) * 0.30)
        const l2 = len * (0.55 + hash(b, k + 31, seed) * 0.35)
        const fx = ex + Math.cos(a2) * l2
        const fy = ey + Math.sin(a2) * l2
        pushBranch(branches, ex, ey, fx, fy, 0.0024)
        const a3 = a2 + k * 0.35
        pushBranch(branches, fx, fy, fx + Math.cos(a3) * l2 * 0.6, fy + Math.sin(a3) * l2 * 0.6, 0.0014)
      }
    }
  }

  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      const d = ell(x, y, cx, cy, rx, ry)
      let v = AIR

      const body = inside(d, 0.012)
      if (body > 0) {
        const tex = fbm(x * 24, y * 24, seed)
        const fine = valueNoise(x * 62, y * 62, seed + 9)
        let tissue
        if (d > 0.965) tissue = -15 // skin
        else if (d > 0.885) tissue = -85 + tex * 30 // subcutaneous fat
        else if (d > 0.815) tissue = 48 + tex * 14 // chest wall muscle
        else {
          const lung = Math.max(
            inside(ell(x, y, cx - 0.16, cy - 0.005, 0.128, 0.205, -0.08), 0.06),
            inside(ell(x, y, cx + 0.16, cy - 0.005, 0.128, 0.205, 0.08), 0.06)
          )
          const mediast = 1 - lung
          let m = 42 + tex * 14
          const hs = 0.055 + 0.055 * heart
          const hrt = inside(ell(x, y, cx - 0.025, cy + 0.055, hs * 1.5, hs * 1.25, -0.25), 0.10)
          m = m * (1 - hrt) + 46 * hrt
          const aorta = inside(ell(x, y, cx + 0.028, cy - 0.055, 0.023, 0.023), 0.20)
          m = m * (1 - aorta) + 52 * aorta
          const svc = inside(ell(x, y, cx - 0.045, cy - 0.06, 0.015, 0.015), 0.25)
          m = m * (1 - svc) + 44 * svc

          let lungV = -845 + fine * 55
          if (lung > 0.01) {
            let vessel = 0
            for (let bi = 0; bi < branches.length; bi++) {
              const br = branches[bi]
              if (x < br[5] || x > br[6] || y < br[7] || y > br[8]) continue
              const reach = br[4] * 2.4
              const dist = segDist(x, y, br[0], br[1], br[2], br[3])
              if (dist < reach) vessel = Math.max(vessel, 1 - dist / reach)
            }
            lungV += (60 - lungV) * vessel // saturates at vessel density, never above it
          }
          tissue = lungV * lung + m * mediast
        }

        // vertebral body, canal and posterior elements
        const vy = cy + ry * 0.76
        const vert = ell(x, y, cx, vy, 0.050, 0.040)
        if (vert < 1.1) {
          const cortex = inside(vert, 0.06) - inside(ell(x, y, cx, vy, 0.039, 0.030), 0.08)
          const marrow = inside(ell(x, y, cx, vy, 0.039, 0.030), 0.08)
          tissue = tissue * (1 - inside(vert, 0.06)) + 1000 * Math.max(0, cortex) + 190 * marrow
        }
        const canal = inside(ell(x, y, cx, vy + 0.048, 0.023, 0.018), 0.15)
        tissue = tissue * (1 - canal) + 34 * canal
        const spinous = inside(ell(x, y, cx, vy + 0.080, 0.010, 0.026), 0.20)
        tissue = tissue * (1 - spinous) + 780 * spinous

        // ribs: 12 discrete cortical arcs sitting in the chest wall
        const ang = Math.atan2(y - cy, x - cx)
        const ribBand = Math.abs(ell(x, y, cx, cy, rx * 0.885, ry * 0.885) - 1)
        if (ribBand < 0.030) {
          const step = (2 * Math.PI) / 12
          const phase = Math.abs(((ang + Math.PI + t * 0.35) % step) / step - 0.5) * 2 // 0 at a rib centre
          if (phase < 0.42) {
            const w = (1 - ribBand / 0.030) * (1 - phase / 0.42)
            tissue = tissue * (1 - w) + 980 * w
          }
        }
        // scapulae on the upper slices
        if (t < 0.3) {
          const sc = Math.max(
            inside(ell(x, y, cx - 0.30, cy - 0.10, 0.055, 0.016, 0.5), 0.20),
            inside(ell(x, y, cx + 0.30, cy - 0.10, 0.055, 0.016, -0.5), 0.20)
          ) * (1 - t / 0.3)
          tissue = tissue * (1 - sc) + 820 * sc
        }

        v = AIR * (1 - body) + tissue * body
      }
      buf[j * N + i] = v
    }
  }
}

function abdomen({ buf, N, t, seed }) {
  const cx = 0.5
  const cy = 0.5
  const rx = 0.40
  const ry = 0.305
  // upper abdomen → pelvis as the stack descends
  const liverSize = Math.max(0, 1 - Math.max(0, (t - 0.15) / 0.55))
  const kidneySize = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.12) / 0.7))))

  // bowel loops: a handful of gas-filled circles that drift with the slice
  const loops = []
  for (let b = 0; b < 7; b++) {
    const a = (b / 7) * 6.2831 + t * 1.7
    const r = 0.055 + hash(b, 3, seed) * 0.085
    loops.push({
      x: cx + Math.cos(a) * r * 1.5,
      y: cy + 0.03 + Math.sin(a) * r,
      rx: 0.020 + hash(b, 9, seed) * 0.022,
      ry: 0.015 + hash(b, 14, seed) * 0.020,
      rot: hash(b, 21, seed) * 3.14,
      // gas sits on top of fluid, so only part of the lumen is dark
      fill: 0.35 + hash(b, 27, seed) * 0.5,
    })
  }

  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      const d = ell(x, y, cx, cy, rx, ry)
      let v = AIR

      const body = inside(d, 0.012)
      if (body > 0) {
        const tex = fbm(x * 20, y * 20, seed)
        const fine = valueNoise(x * 58, y * 58, seed + 9)
        let tissue
        if (d > 0.965) tissue = -15
        else if (d > 0.870) tissue = -92 + tex * 26 // subcutaneous fat
        else if (d > 0.815) tissue = 52 + tex * 12 // abdominal wall muscle
        else {
          tissue = -75 + tex * 40 // mesenteric fat

          const liver = inside(ell(x, y, cx - 0.155, cy - 0.045, 0.185 * (0.55 + 0.45 * liverSize), 0.145 * (0.55 + 0.45 * liverSize), 0.18), 0.06)
          tissue = tissue * (1 - liver) + (61 + fine * 8) * liver
          // portal vessels within the liver
          const pv = inside(ell(x, y, cx - 0.115, cy - 0.02, 0.030, 0.012, 0.4), 0.30) * liver
          tissue = tissue * (1 - pv) + 118 * pv

          const spleen = inside(ell(x, y, cx + 0.215, cy - 0.04, 0.078, 0.098, -0.25), 0.10) * liverSize
          tissue = tissue * (1 - spleen) + 50 * spleen

          const stomach = inside(ell(x, y, cx + 0.075, cy - 0.075, 0.058, 0.042, 0.2), 0.12) * liverSize
          tissue = tissue * (1 - stomach) + 12 * stomach

          const ks = 0.052 * kidneySize
          if (ks > 0.006) {
            for (const side of [-1, 1]) {
              const kx = cx + side * 0.135
              const ky = cy + 0.095
              const k = inside(ell(x, y, kx, ky, ks, ks * 1.35, side * 0.2), 0.12)
              const sinus = inside(ell(x, y, kx - side * 0.012, ky, ks * 0.42, ks * 0.6), 0.22)
              tissue = tissue * (1 - k) + (36 + fine * 8) * k
              tissue = tissue * (1 - sinus * k) + -55 * sinus * k
            }
            // the small calculus the seeded report describes
            if (t > 0.40 && t < 0.60) {
              const st = inside(ell(x, y, cx + 0.128, cy + 0.108, 0.0075, 0.0075), 0.35)
              tissue = tissue * (1 - st) + 620 * st
            }
          }

          for (let li = 0; li < loops.length; li++) {
            const L = loops[li]
            const wall = inside(ell(x, y, L.x, L.y, L.rx, L.ry, L.rot), 0.12)
            if (wall <= 0) continue
            const lumen = inside(ell(x, y, L.x, L.y, L.rx * 0.70, L.ry * 0.70, L.rot), 0.18)
            tissue = tissue * (1 - wall) + 36 * wall
            // gas above, fluid below — an air/fluid level rather than a flat disc
            const gasHere = y < L.y + L.ry * (L.fill - 0.5) * 1.4 ? lumen : 0
            const fluidHere = lumen - gasHere
            tissue = tissue * (1 - gasHere) + -905 * gasHere
            tissue = tissue * (1 - fluidHere) + 14 * fluidHere
          }

          const vy = cy + ry * 0.66
          const aorta = inside(ell(x, y, cx - 0.018, vy - 0.055, 0.020, 0.020), 0.20)
          tissue = tissue * (1 - aorta) + 145 * aorta
          const ivc = inside(ell(x, y, cx + 0.028, vy - 0.058, 0.021, 0.015), 0.22)
          tissue = tissue * (1 - ivc) + 78 * ivc
          for (const side of [-1, 1]) {
            const psoas = inside(ell(x, y, cx + side * 0.055, vy - 0.028, 0.030, 0.026), 0.14)
            tissue = tissue * (1 - psoas) + 54 * psoas
          }
        }

        // lumbar vertebra
        const vy = cy + ry * 0.66
        const vert = ell(x, y, cx, vy, 0.062, 0.050)
        const vBody = inside(vert, 0.05)
        if (vBody > 0) {
          const marrow = inside(ell(x, y, cx, vy, 0.049, 0.038), 0.08)
          tissue = tissue * (1 - vBody) + 1000 * vBody
          tissue = tissue * (1 - marrow) + 165 * marrow
        }
        const canal = inside(ell(x, y, cx, vy + 0.058, 0.028, 0.021), 0.15)
        tissue = tissue * (1 - canal) + 32 * canal
        for (const side of [-1, 1]) {
          const tp = inside(ell(x, y, cx + side * 0.085, vy + 0.020, 0.030, 0.011, side * 0.35), 0.20)
          tissue = tissue * (1 - tp) + 720 * tp
        }
        const spinous = inside(ell(x, y, cx, vy + 0.098, 0.012, 0.034), 0.20)
        tissue = tissue * (1 - spinous) + 760 * spinous

        v = AIR * (1 - body) + tissue * body
      }
      buf[j * N + i] = v
    }
  }
}

function spine({ buf, N, t, seed }) {
  // Sagittal T2 of the lumbar spine. Anterior is left, superior is top.
  // `t` walks left→right through the block, so the canal only appears near midline.
  const mid = Math.max(0, 1 - Math.abs(t - 0.5) * 2.3) // 1 at midline, 0 laterally
  const curve = (y) => 0.470 + 0.050 * Math.sin((y - 0.14) * 2.05) // lumbar lordosis

  const levels = []
  for (let k = 0; k < 7; k++) {
    const y = 0.155 + k * 0.104
    levels.push({ y, x: curve(y) })
  }

  const MARROW = 640
  const RIM = 300 // cortical rim: darker than marrow, not a hard black line
  const NUCLEUS = 830
  const ANNULUS = 250
  const CSF = 890
  const CAUDA = 430
  const MUSCLE = 300
  const FAT = 780

  for (let j = 0; j < N; j++) {
    const y = j / N
    const c = curve(y)
    const near = levels.filter((L) => Math.abs(y - L.y) < 0.13)
    const nearPost = levels.filter((L) => Math.abs(y - L.y) < 0.09)

    for (let i = 0; i < N; i++) {
      const x = i / N
      const tex = fbm(x * 16, y * 16, seed + 3)
      const fine = valueNoise(x * 46, y * 46, seed + 9)
      let v = 0

      const skinFront = 0.095 + 0.030 * Math.sin(y * 3.1 + 1.2)
      const skinBack = 0.900
      if (x <= skinFront || x >= skinBack) {
        buf[j * N + i] = 40 * fine
        continue
      }

      // anterior abdominal contents → psoas/paraspinal muscle → posterior fat
      if (x < c - 0.115) {
        v = 330 + tex * 210
        const aorta = inside(ell(x, y, c - 0.150, 0.5, 0.024, 0.44), 0.12)
        v = v * (1 - aorta) + 90 * aorta // flow void
        const ivc = inside(ell(x, y, c - 0.108, 0.5, 0.018, 0.42), 0.15)
        v = v * (1 - ivc) + 150 * ivc
      } else {
        v = MUSCLE + tex * 110
      }
      if (x > skinBack - 0.070) {
        const w = smooth(Math.min(1, (x - (skinBack - 0.070)) / 0.05))
        v = v * (1 - w) + FAT * w
      }

      const bodyRx = 0.076 * (0.72 + 0.28 * Math.max(0.20, mid))

      for (let n = 0; n < near.length; n++) {
        const L = near[n]
        const k = levels.indexOf(L)

        // vertebral body: fatty marrow inside a softer cortical rim
        const bodyIn = inside(supe(x, y, L.x, L.y, bodyRx, 0.042), 0.10)
        if (bodyIn > 0) {
          const core = inside(supe(x, y, L.x, L.y, bodyRx * 0.88, 0.032), 0.16)
          const marrow = MARROW + fine * 90
          v = v * (1 - bodyIn) + RIM * bodyIn
          v = v * (1 - core) + marrow * core
        }

        // disc below this body
        if (k < levels.length - 1) {
          const Lb = levels[k + 1]
          const dy = (L.y + Lb.y) / 2
          const dx = (L.x + Lb.x) / 2
          const dIn = inside(supe(x, y, dx, dy, bodyRx * 0.94, 0.019), 0.18)
          if (dIn > 0) {
            const nuc = inside(supe(x, y, dx, dy, bodyRx * 0.58, 0.0105), 0.35)
            v = v * (1 - dIn) + (ANNULUS + fine * 60) * dIn
            const desiccated = k >= 2 // matches the seeded report
            v = v * (1 - nuc) + (desiccated ? 400 : NUCLEUS) * nuc
          }
          if (k === 3) {
            const pro = inside(ell(x, y, dx + bodyRx * 0.95, dy, 0.019, 0.017), 0.40)
            v = v * (1 - pro) + 320 * pro // L4–L5 posterior protrusion
          }
        }
      }

      if (mid > 0.05) {
        // thecal sac: bright CSF with the cord above and cauda equina below
        const canalX = c + 0.118
        const sac = inside(supe(x, y, canalX, 0.50, 0.030, 0.44), 0.10) * mid
        v = v * (1 - sac) + CSF * sac
        const cordW = y < 0.35 ? 0.013 : 0.010
        const cord = inside(supe(x, y, canalX - 0.002, 0.50, cordW, 0.42), 0.14) * mid * (y < 0.34 ? 1 : 0.55)
        v = v * (1 - cord) + CAUDA * cord

        // laminae joined to the spinous processes, so nothing floats
        for (let n = 0; n < nearPost.length; n++) {
          const L = nearPost[n]
          const lam = inside(supe(x, y, canalX + 0.048, L.y + 0.016, 0.026, 0.026), 0.20) * mid
          v = v * (1 - lam) + 330 * lam
          const sp = inside(supe(x, y, canalX + 0.105, L.y + 0.040, 0.062, 0.017, 0, 0.36), 0.18) * mid
          v = v * (1 - sp) + 520 * sp
          const ifat = inside(supe(x, y, canalX + 0.100, L.y - 0.014, 0.055, 0.010, 0, 0.36), 0.30) * mid
          v = v * (1 - ifat) + FAT * ifat // interspinous fat
        }
      }

      buf[j * N + i] = v
    }
  }
}

function breast({ buf, N, t, seed }) {
  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      let v = 8
      const d = ell(x, y, 0.0, 0.5, 0.80 - 0.06 * t, 0.42)
      const body = inside(d, 0.02)
      if (body > 0) {
        const depth = Math.min(1, (1 - d) * 5) // thickness falls off toward the skin line
        const fibro = fbm(x * 15, y * 15, seed) * 0.7 + fbm(x * 42, y * 42, seed + 1) * 0.3
        let tissue = 190 + fibro * 430
        // ducts converging on the nipple
        const duct = Math.max(0, 1 - Math.abs(Math.sin((y - 0.5) * 26 + x * 5)) * 3) * (1 - Math.min(1, x * 1.6))
        tissue += duct * 90
        if (x < 0.055) tissue = 660 // pectoral muscle
        v = tissue * depth + 8 * (1 - depth)
        v = v * body
      }
      buf[j * N + i] = v
    }
  }
}

function ultrasound({ buf, N, t, seed }) {
  const apexX = 0.5
  const apexY = 0.03
  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      const dx = x - apexX
      const dy = y - apexY
      const ang = Math.atan2(dx, dy)
      const r = Math.sqrt(dx * dx + dy * dy)
      let v = 0
      if (Math.abs(ang) < 0.60 && r > 0.07 && r < 0.94) {
        const speckle = fbm(x * 150, y * 150, seed + Math.floor(t * 40), 2)
        const organ = inside(ell(x, y, 0.5, 0.44, 0.25, 0.19), 0.08)
        const vessel = inside(ell(x, y, 0.57, 0.50, 0.045, 0.030, 0.4), 0.15)
        const capsule = Math.max(0, 1 - Math.abs(ell(x, y, 0.5, 0.44, 0.25, 0.19) - 1) * 22)
        let base = 150 + organ * 130
        base += speckle * 330
        base = base * (1 - vessel) + 40 * vessel
        base += capsule * 220
        v = base * Math.max(0.32, 1 - r * 0.6) // depth attenuation
        // acoustic shadow behind the vessel wall
        if (Math.abs(ang - 0.16) < 0.02 && r > 0.55) v *= 0.5
      }
      buf[j * N + i] = v
    }
  }
}

function radiograph({ buf, N, seed }) {
  // PA chest radiograph. Higher value = more attenuation = brighter, so the
  // direct beam outside the patient is dark and bone is white.
  const BEAM = 45
  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      const tex = valueNoise(x * 40, y * 40, seed + 5)
      let v = BEAM + tex * 25

      // thorax and shoulders
      // slightly tapered thorax; the shoulders blend in rather than sitting on top
      const thorax = inside(supe(x, y, 0.5, 0.555, 0.345 + 0.045 * y, 0.405), 0.05)
      const shoulders = Math.max(
        inside(ell(x, y, 0.215, 0.275, 0.125, 0.135, 0.35), 0.35),
        inside(ell(x, y, 0.785, 0.275, 0.125, 0.135, -0.35), 0.35)
      )
      const body = Math.min(1, Math.max(thorax, shoulders * 0.9))
      if (body <= 0) {
        buf[j * N + i] = v
        continue
      }

      let tissue = 470 + tex * 40 // chest wall soft tissue

      // lung fields, with the cardiac notch cut out of the patient's left
      const lungR = inside(ell(x, y, 0.335, 0.470, 0.140, 0.250, 0.06), 0.09)
      const lungL = inside(ell(x, y, 0.672, 0.470, 0.140, 0.250, -0.06), 0.09)
      const lung = Math.max(lungR, lungL)
      if (lung > 0) {
        const markings = fbm(x * 26, y * 26, seed, 3)
        tissue = tissue * (1 - lung) + (250 + markings * 150) * lung
      }

      // mediastinum, heart and aortic knuckle
      const heart = inside(ell(x, y, 0.560, 0.605, 0.145, 0.150, 0.14), 0.05)
      tissue = tissue * (1 - heart) + 660 * heart
      const upperMed = inside(supe(x, y, 0.505, 0.300, 0.062, 0.180), 0.15)
      tissue = tissue * (1 - upperMed) + 690 * upperMed
      const knuckle = inside(ell(x, y, 0.585, 0.400, 0.038, 0.030, -0.3), 0.20)
      tissue = tissue * (1 - knuckle) + 700 * knuckle

      // hemidiaphragms — right sits higher than left — and the abdomen below
      const domeR = 0.735 - 0.055 * Math.max(0, 1 - Math.abs(x - 0.34) / 0.20)
      const domeL = 0.775 - 0.045 * Math.max(0, 1 - Math.abs(x - 0.67) / 0.20)
      const dome = x < 0.5 ? domeR : domeL
      if (y > dome) {
        const w = Math.min(1, (y - dome) / 0.035)
        tissue = tissue * (1 - w) + 720 * w
        // gastric bubble under the left dome
        const bubble = inside(ell(x, y, 0.655, 0.820, 0.055, 0.038), 0.20)
        tissue = tissue * (1 - bubble) + 200 * bubble
      }

      // thoracic spine and its disc spaces
      const spineCol = inside(supe(x, y, 0.503, 0.50, 0.030, 0.44), 0.20)
      if (spineCol > 0) {
        const seg = Math.abs(((y - 0.12) / 0.058) % 1 - 0.5) * 2
        tissue = tissue * (1 - spineCol) + (740 + seg * 90) * spineCol
      }

      // posterior ribs: nested arcs opening downward and outward from the spine
      for (let k = 0; k < 10; k++) {
        const yk = 0.135 + k * 0.068
        if (y < yk - 0.02 || y < 0.15) continue
        const d = Math.abs(ell(x, y, 0.5, yk, 0.395, 0.330) - 1)
        if (d < 0.016 && y > yk - 0.02) tissue += 185 * (1 - d / 0.016)
      }
      // anterior ribs: fainter, curving the other way
      for (let k = 0; k < 7; k++) {
        const yk = 0.30 + k * 0.075
        if (y > yk + 0.02) continue
        const d = Math.abs(ell(x, y, 0.5, yk, 0.345, 0.300) - 1)
        if (d < 0.011) tissue += 80 * (1 - d / 0.011)
      }
      // clavicles
      const clav = Math.abs(ell(x, y, 0.5, 0.30, 0.335, 0.165) - 1)
      if (clav < 0.014 && y < 0.24 && Math.abs(x - 0.5) > 0.05) tissue += 230 * (1 - clav / 0.014)
      // scapular edges
      for (const sx of [0.245, 0.755]) {
        const sc = Math.abs(ell(x, y, sx, 0.44, 0.115, 0.215) - 1)
        if (sc < 0.010 && y > 0.28 && y < 0.60) tissue += 90 * (1 - sc / 0.010)
      }

      v = v * (1 - body) + Math.min(1000, tissue) * body
      buf[j * N + i] = v
    }
  }
}

function joint({ buf, N, t, seed }) {
  for (let j = 0; j < N; j++) {
    const y = j / N
    for (let i = 0; i < N; i++) {
      const x = i / N
      let v = 20
      const body = inside(ell(x, y, 0.5, 0.5, 0.33, 0.37), 0.02)
      if (body > 0) {
        let tissue = 250 + fbm(x * 18, y * 18, seed) * 110 // muscle and soft tissue
        if (ell(x, y, 0.5, 0.5, 0.33, 0.37) > 0.90) tissue = 420 // subcutaneous fat
        for (const [cy2, ry2] of [[0.28 - t * 0.02, 0.15], [0.74 + t * 0.02, 0.14]]) {
          const b = inside(ell(x, y, 0.5, cy2, 0.155, ry2), 0.03)
          const marrow = inside(ell(x, y, 0.5, cy2, 0.125, ry2 * 0.78), 0.06)
          tissue = tissue * (1 - b) + 880 * b
          tissue = tissue * (1 - marrow) + 520 * marrow
        }
        const space = inside(ell(x, y, 0.5, 0.51, 0.20, 0.022), 0.20)
        tissue = tissue * (1 - space) + 610 * space // cartilage and joint fluid
        v = tissue * body
      }
      buf[j * N + i] = v
    }
  }
}

/* ---------------------------------------------------------------- registry */

const GENERATORS = { head, chest, abdomen, spine, breast, ultrasound, radiograph, joint }

// how much noise each modality carries, in its own value scale
// tuned against the window each study is actually read at: a brain window is only
// 80 HU wide, so noise that looks right on a lung window destroys grey/white contrast
const NOISE = { head: 3.5, chest: 12, abdomen: 8, spine: 11, breast: 6, ultrasound: 0, radiograph: 6, joint: 10 }

export const anatomyFor = (modality, bodyPart = '') => {
  const b = bodyPart.toLowerCase()
  if (modality === 'Mammography') return 'breast'
  if (modality === 'Ultrasound') return 'ultrasound'
  if (modality === 'X-Ray') return b.includes('chest') ? 'radiograph' : 'joint'
  if (b.includes('brain') || b.includes('head')) return 'head'
  if (b.includes('spine') || b.includes('cervical') || b.includes('lumbar')) return 'spine'
  if (b.includes('chest') || b.includes('thorax') || b.includes('lung')) return 'chest'
  if (b.includes('abdomen') || b.includes('kub') || b.includes('pelvis') || b.includes('obstetric')) return 'abdomen'
  if (b.includes('knee') || b.includes('shoulder')) return 'joint'
  return 'head'
}

const cache = new Map()
const MAX_CACHED = 64
let scratch = null

/** Stored pixel values for one slice. Cached — windowing must never regenerate. */
export function sliceData(anatomy, seriesSeed, z, nz, size, mri) {
  const key = `${anatomy}|${seriesSeed}|${z}|${nz}|${size}|${mri ? 1 : 0}`
  const hit = cache.get(key)
  if (hit) return hit

  const buf = new Float32Array(size * size)
  const gen = GENERATORS[anatomy] || head
  gen({ buf, N: size, t: nz > 1 ? z / (nz - 1) : 0.5, seed: seriesSeed * 31 + 7, mri })

  if (!scratch || scratch.length < buf.length) scratch = new Float32Array(buf.length)
  blur(buf, size, scratch)
  if (mri || anatomy === 'spine') blur(buf, size, scratch) // MRI reads smoother than CT
  const sigma = (NOISE[anatomy] ?? 10) * (mri ? 0.9 : 1)
  if (sigma > 0) addNoise(buf, size, sigma, seriesSeed * 17 + z * 3 + 1)

  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
  cache.set(key, buf)
  return buf
}

/** Apply window/level to stored values and write 8-bit grey into an ImageData. */
export function windowInto(imageData, buf, windowWidth, windowCentre, invert) {
  const px = imageData.data
  const lo = windowCentre - windowWidth / 2
  const scale = 255 / Math.max(1, windowWidth)
  for (let i = 0, p = 0; i < buf.length; i++, p += 4) {
    let g = (buf[i] - lo) * scale
    g = g < 0 ? 0 : g > 255 ? 255 : g
    if (invert) g = 255 - g
    px[p] = px[p + 1] = px[p + 2] = g
    px[p + 3] = 255
  }
}
