import {
  countEditedElements,
  detectHtmlLanguage,
  injectPrintStyles,
  stripCodeFence,
  stripDataUris,
} from '../lib/html-utils'

describe('stripCodeFence', () => {
  it('removes html fences', () => {
    expect(stripCodeFence('```html\n<html></html>\n```')).toBe('<html></html>')
    expect(stripCodeFence('```\n<p>x</p>\n```')).toBe('<p>x</p>')
  })

  it('leaves plain html untouched', () => {
    expect(stripCodeFence('  <html></html>  ')).toBe('<html></html>')
  })
})

describe('stripDataUris', () => {
  it('replaces data uris with placeholders and restores them', () => {
    const a = 'data:image/png;base64,AAAA'
    const b = 'data:image/svg+xml;base64,BBBB=='
    const html = `<img src="${a}"><img src="${b}"><img src="${a}">`
    const { stripped, restore } = stripDataUris(html)
    expect(stripped).toBe('<img src="__IMG_0__"><img src="__IMG_1__"><img src="__IMG_2__">')
    expect(restore(stripped)).toBe(html)
  })

  it('restores unknown placeholders to an empty string', () => {
    expect(stripDataUris('x').restore('a__IMG_9__b')).toBe('ab')
  })
})

describe('detectHtmlLanguage', () => {
  it('reads the lang attribute', () => {
    expect(detectHtmlLanguage('<html lang="en-US"><body></body></html>')).toBe('en')
    expect(detectHtmlLanguage("<html class='x' lang='PL'>")).toBe('pl')
  })

  it('returns null when absent', () => {
    expect(detectHtmlLanguage('<html><body></body></html>')).toBeNull()
  })
})

describe('injectPrintStyles', () => {
  it('inserts before </head>', () => {
    const out = injectPrintStyles('<html><head><title>t</title></head><body>x</body></html>')
    expect(out).toMatch(/<style data-offer-print>[^<]*@page[^<]*<\/style><\/head>/)
  })

  it('falls back to body or prefix', () => {
    expect(injectPrintStyles('<body>x</body>')).toMatch(/^<body><style data-offer-print>/)
    expect(injectPrintStyles('<p>x</p>')).toMatch(/^<style data-offer-print>/)
  })

  it('is idempotent', () => {
    const once = injectPrintStyles('<html><head></head><body>x</body></html>')
    expect(injectPrintStyles(once)).toBe(once)
  })
})

describe('countEditedElements', () => {
  it('counts data-user-edited attributes', () => {
    expect(countEditedElements('<p data-user-edited="1">a</p><div class="x" data-user-edited="1"></div><p>c</p>')).toBe(2)
    expect(countEditedElements('<p>none</p>')).toBe(0)
  })
})
