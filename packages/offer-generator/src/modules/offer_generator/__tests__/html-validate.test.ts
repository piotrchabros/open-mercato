import {
  checkOfferHtmlComplete,
  checkRefineNotShrunk,
  offerBodyTextLength,
} from '../lib/html-validate'

const filler = 'Lorem ipsum dolor sit amet. '.repeat(15)
const validHtml = `<html><head><style>.a{color:red}</style></head><body><h1>Offer</h1><p>${filler}</p></body></html>`

describe('offerBodyTextLength', () => {
  it('counts visible text only', () => {
    expect(offerBodyTextLength('<body><script>var a=1</script><style>p{}</style><!-- c --><p>Hi &amp; bye</p></body>')).toBe(
      'Hi bye'.length,
    )
  })

  it('returns 0 without a body', () => {
    expect(offerBodyTextLength('<p>text</p>')).toBe(0)
  })
})

describe('checkOfferHtmlComplete', () => {
  it('accepts a complete document', () => {
    const result = checkOfferHtmlComplete(validHtml)
    expect(result.ok).toBe(true)
  })

  it('flags a missing </html>', () => {
    expect(checkOfferHtmlComplete(validHtml.replace('</html>', ''))).toMatchObject({ ok: false, issue: 'no-html-close' })
  })

  it('flags a missing body', () => {
    expect(checkOfferHtmlComplete('<html><div>x</div></html>')).toMatchObject({ ok: false, issue: 'no-body' })
  })

  it('flags an empty body', () => {
    expect(checkOfferHtmlComplete('<html><body><p>short</p></body></html>')).toMatchObject({
      ok: false,
      issue: 'empty-body',
    })
  })
})

describe('checkRefineNotShrunk', () => {
  it('skips small bases', () => {
    expect(checkRefineNotShrunk('a'.repeat(100), 'a')).toMatchObject({ ok: true })
    expect(checkRefineNotShrunk('', 'abc')).toEqual({ ok: true, ratio: 1 })
  })

  it('accepts comparable output', () => {
    expect(checkRefineNotShrunk('a'.repeat(4000), 'a'.repeat(3000))).toEqual({ ok: true, ratio: 0.75 })
  })

  it('rejects output shrunk below half', () => {
    expect(checkRefineNotShrunk('a'.repeat(4000), 'a'.repeat(1000))).toEqual({
      ok: false,
      issue: 'refine-shrunk',
      ratio: 0.25,
      shrinkPercent: 75,
    })
  })
})
