jest.mock('@open-mercato/documents/modules/documents/lib/pdfRenderer', () => ({
  renderPdfWithChromium: jest.fn(),
}))

import {
  buildOfferPdfFilename,
  isAllowedOfferPdfRequest,
  readPdfAssetHosts,
  resolveOfferPdfChromiumPath,
} from '../lib/pdf'

const hosts = readPdfAssetHosts({})

const request = (overrides: Partial<Parameters<typeof isAllowedOfferPdfRequest>[0]>) => ({
  url: 'https://fonts.gstatic.com/s/inter.woff2',
  resourceType: 'font',
  isNavigationRequest: false,
  ...overrides,
})

describe('isAllowedOfferPdfRequest', () => {
  it('allows data images and fonts', () => {
    expect(isAllowedOfferPdfRequest(request({ url: 'data:image/png;base64,AAAA', resourceType: 'image' }), hosts)).toBe(true)
    expect(isAllowedOfferPdfRequest(request({ url: 'data:font/woff2;base64,AAAA', resourceType: 'font' }), hosts)).toBe(true)
  })

  it('denies data URIs for stylesheets', () => {
    expect(isAllowedOfferPdfRequest(request({ url: 'data:text/css,body{}', resourceType: 'stylesheet' }), hosts)).toBe(false)
  })

  it('allows allowlisted https hosts', () => {
    expect(isAllowedOfferPdfRequest(request({}), hosts)).toBe(true)
    expect(
      isAllowedOfferPdfRequest(
        request({ url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/all.min.css', resourceType: 'stylesheet' }),
        hosts,
      ),
    ).toBe(true)
  })

  it('denies other hosts and lookalikes', () => {
    expect(isAllowedOfferPdfRequest(request({ url: 'https://evil.example.com/a.woff2' }), hosts)).toBe(false)
    expect(isAllowedOfferPdfRequest(request({ url: 'https://fonts.gstatic.com.evil.example/a.woff2' }), hosts)).toBe(false)
  })

  it('denies http, navigation, scripts and malformed urls', () => {
    expect(isAllowedOfferPdfRequest(request({ url: 'http://fonts.gstatic.com/a.woff2' }), hosts)).toBe(false)
    expect(isAllowedOfferPdfRequest(request({ isNavigationRequest: true }), hosts)).toBe(false)
    expect(isAllowedOfferPdfRequest(request({ resourceType: 'script' }), hosts)).toBe(false)
    expect(isAllowedOfferPdfRequest(request({ url: 'not a url' }), hosts)).toBe(false)
  })
})

describe('readPdfAssetHosts', () => {
  it('uses the default allowlist', () => {
    expect(readPdfAssetHosts({})).toEqual(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'])
  })

  it('parses the env override', () => {
    expect(readPdfAssetHosts({ OM_OFFER_GENERATOR_PDF_ASSET_HOSTS: ' Cdn.Example.com, ,b.example.com ' })).toEqual([
      'cdn.example.com',
      'b.example.com',
    ])
  })
})

describe('resolveOfferPdfChromiumPath', () => {
  it('prefers the offer generator variable', () => {
    expect(
      resolveOfferPdfChromiumPath({
        OM_OFFER_GENERATOR_PDF_CHROMIUM_PATH: '/opt/a',
        DOCUMENTS_PDF_CHROMIUM_PATH: '/opt/b',
        PUPPETEER_EXECUTABLE_PATH: '/opt/c',
      }),
    ).toBe('/opt/a')
  })

  it('falls back through documents and puppeteer variables', () => {
    expect(
      resolveOfferPdfChromiumPath({ DOCUMENTS_PDF_CHROMIUM_PATH: '/opt/b', PUPPETEER_EXECUTABLE_PATH: '/opt/c' }),
    ).toBe('/opt/b')
    expect(resolveOfferPdfChromiumPath({ PUPPETEER_EXECUTABLE_PATH: '/opt/c' })).toBe('/opt/c')
  })
})

describe('buildOfferPdfFilename', () => {
  it('builds a safe filename from the slug', () => {
    expect(buildOfferPdfFilename({ slug: 'Oferta Acme/2026' })).toBe('oferta-acme-2026.pdf')
    expect(buildOfferPdfFilename({ slug: '' })).toBe('offer.pdf')
  })
})
