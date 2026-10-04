// Export the synthetic cardiac CT phantom (src/imaging/phantom.js) as raw stored
// pixels so tools/send_test_study.py can wrap them in real CT DICOM.
//
//   node tools/export_phantom.mjs <outDir>
//
// Writes, per series: <key>.raw (uint16 little endian, slice-major, rows x cols)
// and manifest.json with geometry and the series' DICOM tags.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARDIAC_SERIES, MATRIX, PIXEL_MM, storedSlice } from '../src/imaging/phantom.js'

const out = process.argv[2] || 'phantom-export'
mkdirSync(out, { recursive: true })
const manifest = { matrix: MATRIX, pixelMm: PIXEL_MM, series: [] }
for (const s of CARDIAC_SERIES) {
  const buf = Buffer.alloc(s.slices * MATRIX * MATRIX * 2)
  for (let k = 0; k < s.slices; k++) {
    const raw = storedSlice(s, k, MATRIX)
    Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).copy(buf, k * MATRIX * MATRIX * 2)
  }
  const file = `${s.key}.raw`
  writeFileSync(join(out, file), buf)
  manifest.series.push({
    key: s.key, name: s.name, file, slices: s.slices, rows: MATRIX, columns: MATRIX,
    thickness: s.thickness, increment: s.increment, z0: s.z0, contrast: s.contrast,
    positions: Array.from({ length: s.slices }, (_, k) => s.z0 + k * s.increment),
    pixelSpacing: [PIXEL_MM, PIXEL_MM], dicom: s.dicom,
  })
  process.stderr.write(`exported ${s.key}: ${s.slices} slices\n`)
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
