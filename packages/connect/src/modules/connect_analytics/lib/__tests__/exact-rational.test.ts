import { addRationals, reduceRational, serializeRational } from '../exact-rational'

describe('exact rational arithmetic', () => {
  it('reduces values and canonicalizes zero', () => {
    expect(reduceRational({ numerator: 42n, denominator: 56n })).toEqual({ numerator: 3n, denominator: 4n })
    expect(reduceRational({ numerator: 0n, denominator: 999n })).toEqual({ numerator: 0n, denominator: 1n })
  })

  it('adds fractions without floating-point precision loss', () => {
    expect(addRationals(
      { numerator: 1n, denominator: 6n },
      { numerator: 1n, denominator: 4n },
    )).toEqual({ numerator: 5n, denominator: 12n })
  })

  it('supports values beyond the JavaScript safe integer range', () => {
    expect(serializeRational({
      numerator: 9_223_372_036_854_775_807n * 3n,
      denominator: 11n,
    })).toEqual({
      numerator: '27670116110564327421',
      denominator: '11',
    })
  })

  it('rejects a zero denominator', () => {
    expect(() => reduceRational({ numerator: 1n, denominator: 0n })).toThrow('denominator')
  })
})
