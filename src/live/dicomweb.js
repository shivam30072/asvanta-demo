/**
 * DICOMweb series loading for the viewer, through the gateway proxy.
 *
 *   metadata  GET {base}/studies/{study}/series/{series}/metadata        (DICOM JSON)
 *   frames    GET {base}/studies/{study}/series/{series}/instances/{sop}/frames/1
 *             Accept: multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1
 *             → uncompressed little-endian pixels; the PACS transcodes compressed images.
 *
 * `source` = { base, auth, studyUID, seriesUID }: `base` is '/dicomweb' for staff and
 * radiologists, '/s/{token}/dicomweb' for a share-link recipient, whose scoped token is `auth`.
 */
import { apiRaw } from './api'

export const FRAME_ACCEPT = 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1'

/* ---------------------------------------------------------- DICOM JSON tags */

const T = {
  SOPInstanceUID: '00080018',
  Modality: '00080060',
  Manufacturer: '00080070',
  ManufacturerModelName: '00081090',
  SeriesDescription: '0008103E',
  ContrastBolusAgent: '00180010',
  SliceThickness: '00180050',
  SpacingBetweenSlices: '00180088',
  KVP: '00180060',
  ConvolutionKernel: '00181210',
  CardiacSynchronizationTechnique: '00189037',
  NominalPercentageOfCardiacPhase: '00209241',
  InstanceNumber: '00200013',
  ImagePositionPatient: '00200032',
  ImageOrientationPatient: '00200037',
  SamplesPerPixel: '00280002',
  PhotometricInterpretation: '00280004',
  NumberOfFrames: '00280008',
  Rows: '00280010',
  Columns: '00280011',
  PixelSpacing: '00280030',
  ImagerPixelSpacing: '00181164',
  BitsAllocated: '00280100',
  BitsStored: '00280101',
  PixelRepresentation: '00280103',
  WindowCenter: '00281050',
  WindowWidth: '00281051',
  RescaleIntercept: '00281052',
  RescaleSlope: '00281053',
  HeartRate: '00181088',
}

/** All values of a tag (numbers parsed), or [] if absent. */
export function values(inst, tag) {
  const el = inst[T[tag] || tag]
  if (!el || !el.Value) return []
  return el.Value.map((v) => (typeof v === 'string' && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(v.trim()) ? Number(v) : v?.Alphabetic ?? v))
}
export const value = (inst, tag) => values(inst, tag)[0] ?? null

/** The tags the CAC validator and viewer read, as plain fields. */
export function tagsOf(inst) {
  const px = values(inst, 'PixelSpacing')
  return {
    Modality: value(inst, 'Modality'),
    Manufacturer: value(inst, 'Manufacturer'),
    ManufacturerModelName: value(inst, 'ManufacturerModelName'),
    SeriesDescription: value(inst, 'SeriesDescription'),
    SliceThickness: value(inst, 'SliceThickness'),
    SpacingBetweenSlices: value(inst, 'SpacingBetweenSlices'),
    PixelSpacing: px.length ? px : values(inst, 'ImagerPixelSpacing'),
    KVP: value(inst, 'KVP'),
    ContrastBolusAgent: value(inst, 'ContrastBolusAgent') || null,
    CardiacSynchronizationTechnique: value(inst, 'CardiacSynchronizationTechnique'),
    NominalPercentageOfCardiacPhase: value(inst, 'NominalPercentageOfCardiacPhase'),
    ConvolutionKernel: value(inst, 'ConvolutionKernel'),
    RescaleSlope: value(inst, 'RescaleSlope'),
    RescaleIntercept: value(inst, 'RescaleIntercept'),
    ImageOrientationPatient: values(inst, 'ImageOrientationPatient'),
    HeartRate: value(inst, 'HeartRate'),
  }
}

/* --------------------------------------------------------------- geometry */

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/**
 * Sort instances along the slice normal (not by InstanceNumber) and work out the
 * slice increment. Instances without positions (radiographs) keep instance order.
 */
export function orderInstances(instances) {
  const iop = values(instances[0], 'ImageOrientationPatient')
  const withPos = instances.every((i) => values(i, 'ImagePositionPatient').length === 3)
  if (iop.length !== 6 || !withPos) {
    const sorted = [...instances].sort((a, b) => (value(a, 'InstanceNumber') ?? 0) - (value(b, 'InstanceNumber') ?? 0))
    return { sorted, positions: sorted.map((_, k) => k), increment: value(instances[0], 'SliceThickness') || 1 }
  }
  const normal = cross(iop.slice(0, 3), iop.slice(3, 6))
  const proj = (i) => {
    const p = values(i, 'ImagePositionPatient')
    return p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2]
  }
  // scanner z runs inferior → superior; the viewer stacks superior → inferior
  const sorted = [...instances].sort((a, b) => proj(b) - proj(a))
  const positions = sorted.map((i) => -proj(i))
  const gaps = positions.slice(1).map((p, k) => p - positions[k]).filter((g) => g > 1e-3)
  const increment = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : value(instances[0], 'SliceThickness') || 1
  return { sorted, positions, increment }
}

/* -------------------------------------------------------------- multipart */

const enc = new TextEncoder()

function indexOf(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Split a multipart/related body into its parts' byte ranges. */
export function parseMultipart(buffer, contentType) {
  const bytes = new Uint8Array(buffer)
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '')
  if (!m) return [bytes] // single-part response
  const delim = enc.encode(`--${m[1]}`)
  const parts = []
  let pos = indexOf(bytes, delim)
  while (pos >= 0) {
    const headerStart = pos + delim.length
    if (bytes[headerStart] === 45 && bytes[headerStart + 1] === 45) break // closing "--"
    const headerEnd = indexOf(bytes, enc.encode('\r\n\r\n'), headerStart)
    if (headerEnd < 0) break
    const next = indexOf(bytes, delim, headerEnd + 4)
    const end = next < 0 ? bytes.length : next - 2 // drop the CRLF before the delimiter
    parts.push(bytes.subarray(headerEnd + 4, end))
    pos = next
  }
  return parts
}

/* ----------------------------------------------------------- pixel decode */

/**
 * Convert one uncompressed frame to rescaled values (HU for CT), written into
 * `out` at `offset`. Colour (RGB) is reduced to luminance; MONOCHROME1 is
 * returned as-is and flagged so the viewer inverts it.
 */
export function decodeFrame(bytes, inst, out, offset = 0) {
  const rows = value(inst, 'Rows')
  const cols = value(inst, 'Columns')
  const n = rows * cols
  const bits = value(inst, 'BitsAllocated') || 16
  const signed = value(inst, 'PixelRepresentation') === 1
  const spp = value(inst, 'SamplesPerPixel') || 1
  const slope = value(inst, 'RescaleSlope') ?? 1
  const intercept = value(inst, 'RescaleIntercept') ?? 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (spp === 3) {
    for (let i = 0; i < n; i++) {
      const r = bytes[i * 3]
      const g = bytes[i * 3 + 1]
      const b = bytes[i * 3 + 2]
      out[offset + i] = 0.299 * r + 0.587 * g + 0.114 * b
    }
    return
  }
  if (bits === 8) {
    for (let i = 0; i < n; i++) out[offset + i] = (signed ? (bytes[i] << 24) >> 24 : bytes[i]) * slope + intercept
    return
  }
  for (let i = 0; i < n; i++) {
    const raw = signed ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true)
    out[offset + i] = raw * slope + intercept
  }
}

/* ------------------------------------------------------------ the loader */

const seriesPath = (s) => `${s.base}/studies/${s.studyUID}/series/${s.seriesUID}`

const metaCache = new Map()

/** Instance metadata for a series; fetched once per series and shared by thumbnails and loading. */
export function fetchSeriesMetadata(source) {
  const key = seriesPath(source)
  if (!metaCache.has(key)) {
    const p = apiRaw(`${key}/metadata`, { accept: 'application/dicom+json', auth: source.auth }).then((r) => r.json())
    p.catch(() => metaCache.delete(key))
    metaCache.set(key, p)
  }
  return metaCache.get(key)
}

/** SOP Instance UID of the middle image, for a representative thumbnail. */
export async function middleInstance(source) {
  const meta = await fetchSeriesMetadata(source)
  const { sorted } = orderInstances(meta)
  return value(sorted[Math.floor(sorted.length / 2)], 'SOPInstanceUID')
}

async function fetchFrame(source, sop) {
  const res = await apiRaw(`${seriesPath(source)}/instances/${sop}/frames/1`, { accept: FRAME_ACCEPT, auth: source.auth })
  const parts = parseMultipart(await res.arrayBuffer(), res.headers.get('content-type'))
  return parts[0]
}

/**
 * Load a whole series into a volume (see src/imaging/volume.js for the format).
 * Frames are fetched a few at a time; `onProgress` runs 0 → 1.
 */
export async function loadDicomVolume(source, onProgress = () => {}) {
  const meta = await fetchSeriesMetadata(source)
  if (!meta.length) throw new Error('Series has no instances')
  const { sorted, positions, increment } = orderInstances(meta)
  const first = sorted[0]
  const rows = value(first, 'Rows')
  const cols = value(first, 'Columns')
  const plane = rows * cols
  // signed 16-bit is enough for HU and most MR; full-range unsigned data needs floats
  const wide = (value(first, 'BitsStored') || 16) > 15 && value(first, 'PixelRepresentation') !== 1 && (value(first, 'RescaleSlope') ?? 1) === 1 && (value(first, 'RescaleIntercept') ?? 0) >= 0
  const hu = wide || (value(first, 'SamplesPerPixel') || 1) === 3 ? new Float32Array(plane * sorted.length) : new Int16Array(plane * sorted.length)

  let done = 0
  const queue = sorted.map((inst, k) => ({ inst, k }))
  const worker = async () => {
    while (queue.length) {
      const { inst, k } = queue.shift()
      const bytes = await fetchFrame(source, value(inst, 'SOPInstanceUID'))
      decodeFrame(bytes, inst, hu, k * plane)
      done++
      onProgress(done / sorted.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, sorted.length) }, worker))

  const tags = tagsOf(first)
  const px = tags.PixelSpacing?.length === 2 ? tags.PixelSpacing : [1, 1]
  const mid = sorted[Math.floor(sorted.length / 2)]
  return {
    hu,
    dims: [cols, rows, sorted.length],
    // PixelSpacing is (row spacing, column spacing): column spacing is the x step
    spacing: [px[1], px[0], increment],
    z0: positions[0],
    rescale: tags.RescaleSlope != null ? { slope: tags.RescaleSlope, intercept: tags.RescaleIntercept ?? 0 } : null,
    meta: tags,
    monochrome1: value(first, 'PhotometricInterpretation') === 'MONOCHROME1',
    window: value(mid, 'WindowWidth') ? { ww: value(mid, 'WindowWidth'), wc: value(mid, 'WindowCenter') } : null,
  }
}

/** A JPEG of the middle instance for thumbnails, as an object URL. */
export async function fetchThumbnail(source, sop) {
  const res = await apiRaw(`${seriesPath(source)}/instances/${sop}/rendered?viewport=128,128`, { accept: 'image/jpeg', auth: source.auth })
  return URL.createObjectURL(await res.blob())
}
