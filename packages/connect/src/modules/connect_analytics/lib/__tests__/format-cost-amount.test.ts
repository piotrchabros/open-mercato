import { formatCostAmount } from '../format-cost-amount'

describe('formatCostAmount', () => {
  it('scales minor units using the currency fraction digits', () => {
    expect(formatCostAmount('1250', 'USD', 'en-US', '—')).toBe('12.50 USD')
    expect(formatCostAmount('1250', 'EUR', 'de-DE', '—')).toBe('12,50 EUR')
  })

  it('supports currencies without fractional units', () => {
    expect(formatCostAmount('1250', 'JPY', 'en-US', '—')).toBe('1,250 JPY')
  })

  it('preserves exact 64-bit minor-unit values', () => {
    expect(formatCostAmount('9223372036854775807', 'USD', 'en-US', '—'))
      .toBe('92,233,720,368,547,758.07 USD')
  })

  it('falls back for missing and invalid values', () => {
    expect(formatCostAmount(null, 'USD', 'en-US', '—')).toBe('—')
    expect(formatCostAmount('invalid', 'USD', 'en-US', '—')).toBe('—')
    expect(formatCostAmount('1250', null, 'en-US', '—')).toBe('1,250')
  })
})
