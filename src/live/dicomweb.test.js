import { describe, expect, it } from 'vitest'
import { decodeFrame, orderInstances, parseMultipart, tagsOf, value } from './dicomweb'

const inst = (o) => ({
  '00080018': { vr: 'UI', Value: [o.sop || '1.2.3'] },
  '00080060': { vr: 'CS', Value: ['CT'] },
  '00200013': { vr: 'IS', Value: [o.n ?? 1] },
  '00200032': o.pos ? { vr: 'DS', Value: o.pos } : undefined,
  '00200037': { vr: 'DS', Value: [1, 0, 0, 0, 1, 0] },
  '00280010': { vr: 'US', Value: [o.rows ?? 2] },
  '00280011': { vr: 'US', Value: [o.cols ?? 2] },
  '00280030': { vr: 'DS', Value: ['0.5', '0.7'] },
  '00280100': { vr: 'US', Value: [16] },
  '00280101': { vr: 'US', Value: [12] },
  '00280103': { vr: 'US', Value: [o.signed ? 1 : 0] },
  '00281052': { vr: 'DS', Value: [String(o.intercept ?? -1024)] },
  '00281053': { vr: 'DS', Value: ['1'] },
  '00180050': { vr: 'DS', Value: ['3'] },
})

describe('DICOM JSON', () => {
  it('reads numbers stored as strings and pixel spacing', () => {
    const t = tagsOf(inst({}))
    expect(t.RescaleIntercept).toBe(-1024)
    expect(t.PixelSpacing).toEqual([0.5, 0.7])
    expect(t.Modality).toBe('CT')
    expect(value(inst({}), 'Rows')).toBe(2)
  })

  it('orders slices by position along the normal, superior first, not by instance number', () => {
    const a = inst({ sop: 'a', n: 1, pos: [0, 0, -6] })
    const b = inst({ sop: 'b', n: 2, pos: [0, 0, 0] })
    const c = inst({ sop: 'c', n: 3, pos: [0, 0, -3] })
    const { sorted, increment, positions } = orderInstances([a, b, c])
    expect(sorted.map((i) => value(i, 'SOPInstanceUID'))).toEqual(['b', 'c', 'a'])
    expect(increment).toBeCloseTo(3)
    expect(positions).toEqual([-0, 3, 6])
  })

  it('falls back to instance order without positions', () => {
    const { sorted } = orderInstances([inst({ sop: 'y', n: 2 }), inst({ sop: 'x', n: 1 })])
    expect(sorted.map((i) => value(i, 'SOPInstanceUID'))).toEqual(['x', 'y'])
  })
})

describe('multipart frames', () => {
  it('extracts the binary part from a multipart/related body', () => {
    const payload = new Uint8Array([1, 2, 13, 10, 45, 45, 3, 4]) // contains CRLF and "--" inside the data
    const head = new TextEncoder().encode('--XYZ\r\nContent-Type: application/octet-stream\r\n\r\n')
    const tail = new TextEncoder().encode('\r\n--XYZ--\r\n')
    const body = new Uint8Array([...head, ...payload, ...tail])
    const [part] = parseMultipart(body.buffer, 'multipart/related; type="application/octet-stream"; boundary=XYZ')
    expect([...part]).toEqual([...payload])
  })

  it('passes a single-part body through', () => {
    const [part] = parseMultipart(new Uint8Array([7, 8]).buffer, 'application/octet-stream')
    expect([...part]).toEqual([7, 8])
  })
})

describe('pixel decoding', () => {
  it('applies rescale to unsigned 16-bit little-endian pixels', () => {
    const raw = new Uint8Array(new Uint16Array([0, 1024, 1154, 2048]).buffer)
    const out = new Float32Array(4)
    decodeFrame(raw, inst({}), out)
    expect([...out]).toEqual([-1024, 0, 130, 1024])
  })

  it('handles signed pixels', () => {
    const raw = new Uint8Array(new Int16Array([-1000, -1, 0, 400]).buffer)
    const out = new Int16Array(4)
    decodeFrame(raw, inst({ signed: true, intercept: 0 }), out)
    expect([...out]).toEqual([-1000, -1, 0, 400])
  })
})
