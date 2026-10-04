import { describe, expect, it } from 'vitest'
import { normaliseMobile } from './SendToMobileModal'

describe('normaliseMobile', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['+44 7700 900123', '+447700900123'],
  ])('%s → %s', (input, out) => expect(normaliseMobile(input)).toBe(out))

  it.each(['', '12345', '5876543210', 'abc', '+12'])('rejects %s', (input) => expect(normaliseMobile(input)).toBeNull())
})
