import fs from 'fs'
import path from 'path'
import { sanitizeOfferHtml } from '../lib/html-sanitize'
import { DEFAULT_OFFER_TEMPLATE } from '../lib/default-template'
import { checkOfferHtmlComplete } from '../lib/html-validate'

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'oferta-pakiety.html'), 'utf-8')

describe('sanitizeOfferHtml', () => {
  it('removes scripts, iframes, forms and inputs', () => {
    const out = sanitizeOfferHtml(
      '<html><body><script>alert(1)</script><iframe src="https://evil.test"></iframe><form action="/x"><input name="a"></form><object data="x"></object><embed src="x"><p>ok</p></body></html>',
    )
    expect(out).not.toMatch(/<script|<iframe|<form|<input|<object|<embed|alert\(1\)/i)
    expect(out).toContain('<p>ok</p>')
  })

  it('removes on* attributes', () => {
    const out = sanitizeOfferHtml('<body><p onclick="x()" onmouseover="y()" class="k">t</p><img src="https://a.test/i.png" onerror="z()"></body>')
    expect(out).not.toMatch(/onclick|onmouseover|onerror/i)
    expect(out).toContain('class="k"')
  })

  it('removes javascript and vbscript urls', () => {
    const out = sanitizeOfferHtml('<body><a href="javascript:alert(1)">a</a><a href="  JaVaScRiPt:alert(2)">b</a><a href="https://ok.test">c</a></body>')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('href="https://ok.test"')
  })

  it('allows mailto and tel but not http', () => {
    const out = sanitizeOfferHtml('<body><a href="mailto:a@b.co">m</a><a href="tel:+48123">t</a><a href="http://plain.test">h</a></body>')
    expect(out).toContain('mailto:a@b.co')
    expect(out).toContain('tel:+48123')
    expect(out).not.toContain('http://plain.test')
  })

  it('allows data uris only on img', () => {
    const pixel = 'data:image/png;base64,iVBORw0KGgo='
    const out = sanitizeOfferHtml(`<body><img src="${pixel}"><a href="${pixel}">x</a></body>`)
    expect(out).toContain(`<img src="${pixel}"`)
    expect(out).not.toContain(`href="${pixel}"`)
  })

  it('keeps only https stylesheet and icon links', () => {
    const out = sanitizeOfferHtml(
      '<html><head><link rel="stylesheet" href="https://cdn.test/a.css"><link rel="icon" href="https://cdn.test/f.png"><link rel="stylesheet" href="http://cdn.test/b.css"><link rel="preload" href="https://cdn.test/c.js"><link rel="stylesheet" href="javascript:x"></head><body>x</body></html>',
    )
    expect(out).toContain('https://cdn.test/a.css')
    expect(out).toContain('https://cdn.test/f.png')
    expect(out).not.toContain('http://cdn.test/b.css')
    expect(out).not.toContain('preload')
    expect(out).not.toContain('javascript:')
  })

  it('keeps style blocks, data attributes and the document skeleton', () => {
    const out = sanitizeOfferHtml(
      '<html lang="en"><head><meta charset="utf-8"><title>T</title><style>.a > .b{color:red}</style></head><body><p data-user-edited="1" data-x="2">edited</p></body></html>',
    )
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('<html lang="en">')
    expect(out).toContain('<style>.a > .b{color:red}</style>')
    expect(out).toContain('data-user-edited="1"')
    expect(out).toContain('data-x="2"')
    expect(out).toContain('<title>T</title>')
  })

  it('sanitizes the BlueBee template fixture while keeping structure', () => {
    const out = sanitizeOfferHtml(fixture)
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toMatch(/<style>[\s\S]+<\/style>/)
    expect(out).toContain('class="cards"')
    expect(out).toContain('class="svc-list"')
    expect(out).not.toMatch(/<script/i)
    expect(out).toContain('</html>')
  })

  it('keeps inline svg presentation markup', () => {
    const out = sanitizeOfferHtml(
      '<body><svg class="i" viewBox="0 0 40 40" fill="currentColor" aria-hidden="true"><g transform="scale(2)"><path d="M6 30 C 12 10, 26 8, 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="34" cy="14" r="3.2"/><rect x="1" y="1" width="4" height="4"/><polygon points="0,0 1,1 0,1"/></g></svg></body>',
    )
    expect(out).toContain('<svg class="i" viewbox="0 0 40 40" fill="currentColor" aria-hidden="true">')
    expect(out).toContain('<g transform="scale(2)">')
    expect(out).toContain('<path d="M6 30 C 12 10, 26 8, 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>')
    expect(out).toContain('<circle cx="34" cy="14" r="3.2"></circle>')
    expect(out).toContain('<rect x="1" y="1" width="4" height="4"></rect>')
    expect(out).toContain('<polygon points="0,0 1,1 0,1"></polygon>')
  })

  it('strips dangerous svg content', () => {
    const out = sanitizeOfferHtml(
      '<body><svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><use href="https://evil.test/s.svg#a"></use><image href="https://evil.test/i.png"></image><animate attributeName="href" to="javascript:x"></animate><path d="M0 0h1" fill="url(https://evil.test/p.svg#g)" stroke="javascript:x" style="fill:red"/><a href="javascript:alert(2)"><circle r="1"/></a></svg></body>',
    )
    expect(out).not.toMatch(/onload|<script|alert\(|foreignobject|<iframe|<use|<image|<animate|evil\.test|javascript:/i)
    expect(out).toContain('<path d="M0 0h1" style="fill:red"></path>')
    expect(out).toContain('<circle r="1"></circle>')
  })

  it('keeps the default template intact in structure', () => {
    const out = sanitizeOfferHtml(DEFAULT_OFFER_TEMPLATE)
    expect(out).toContain('<html lang="pl">')
    expect(out).toContain('class="svc-list"')
    expect(out).toContain('class="cards"')
    expect(out).toContain('class="price-was"')
    expect(out).toContain('<tr class="is-total">')
    expect(out).toContain('class="tbl"')
    expect(out).toContain('@media print')
    expect(out).toContain('</html>')
  })

  it('keeps the default template logo, font stylesheet and tracked sections', () => {
    const out = sanitizeOfferHtml(DEFAULT_OFFER_TEMPLATE)
    expect(out).toMatch(/<svg class="logo-mark" viewbox="0 0 364 392" fill="currentColor" aria-hidden="true"><path d="M[^"]{500,}"><\/path><\/svg>/)
    expect(out).toMatch(/<svg class="logo-word" viewbox="[^"]+" fill="currentColor" aria-hidden="true"><path d="M[^"]{500,}"><\/path><\/svg>/)
    expect(out).toContain(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&amp;family=Geist+Mono:wght@400;500&amp;family=Instrument+Serif:ital@1&amp;display=swap" />',
    )
    const sections = out.match(/<section\b[^>]*\bdata-section\b[^>]*>/g) ?? []
    expect(sections.length).toBeGreaterThanOrEqual(8)
    const labels = out.match(/<p class="kicker sec-label">[^<]+<\/p>/g) ?? []
    expect(labels).toHaveLength(sections.length)
    expect(out).not.toMatch(/<script|<form|<input|<img|base64/i)
  })

  it('passes the completeness check for the default template before and after sanitizing', () => {
    expect(checkOfferHtmlComplete(DEFAULT_OFFER_TEMPLATE).ok).toBe(true)
    expect(checkOfferHtmlComplete(sanitizeOfferHtml(DEFAULT_OFFER_TEMPLATE)).ok).toBe(true)
  })

  it('keeps the default template lean enough to send with every prompt', () => {
    expect(new TextEncoder().encode(DEFAULT_OFFER_TEMPLATE).length).toBeLessThan(30 * 1024)
  })

  it('is idempotent', () => {
    const once = sanitizeOfferHtml(DEFAULT_OFFER_TEMPLATE)
    expect(sanitizeOfferHtml(once)).toBe(once)
  })
})
