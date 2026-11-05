import { buildDefaultSettingsValues, DEFAULT_COMPANY_NAME } from '../lib/settings'
import { DEFAULT_OFFER_TEMPLATE } from '../lib/default-template'

describe('default settings', () => {
  it('defaults to the BlueBee company name and the BlueBee template', () => {
    const values = buildDefaultSettingsValues()
    expect(DEFAULT_COMPANY_NAME).toBe('BlueBee')
    expect(values.companyName).toBe('BlueBee')
    expect(values.templateHtml).toBe(DEFAULT_OFFER_TEMPLATE)
    expect(values.defaultLanguage).toBe('pl')
  })
})
