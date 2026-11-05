import {
  buildCompletenessChecklist,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  extractBulletPoints,
  extractMarkdownTables,
} from '../lib/prompts'
import { DEFAULT_OFFER_TEMPLATE } from '../lib/default-template'

const table = ['| Item | Regular | Price |', '| --- | --- | --- |', '| A | ~~2000~~ | 1500 |', '| **Total** | ~~2000~~ | 1500 |'].join('\n')

describe('system prompts', () => {
  it('embeds template, company, language and extra instructions in the generate prompt', () => {
    const prompt = buildGenerateSystemPrompt({
      template: '<html>TEMPLATE_MARKER</html>',
      language: 'de',
      companyName: 'Acme Studio',
      extraInstructions: 'Always mention the 30 day guarantee.',
    })
    expect(prompt).toContain('TEMPLATE_MARKER')
    expect(prompt).toContain('Acme Studio')
    expect(prompt).toContain('<html lang="de">')
    expect(prompt).toContain('GERMAN')
    expect(prompt).toContain('30 day guarantee')
    expect(prompt).toContain('SACRED')
    expect(prompt).not.toMatch(/BlueBee/i)
  })

  it('falls back to a neutral company label and omits empty extra instructions', () => {
    const prompt = buildGenerateSystemPrompt({ template: DEFAULT_OFFER_TEMPLATE, language: 'en', companyName: null })
    expect(prompt).toContain('the company')
    expect(prompt).not.toContain('ADDITIONAL INSTRUCTIONS')
  })

  it('describes the default template components the model may duplicate', () => {
    const prompt = buildGenerateSystemPrompt({ template: DEFAULT_OFFER_TEMPLATE, language: 'pl', companyName: 'BlueBee' })
    for (const className of ['sec-label', 'svc-item', 'svc-txt', 'card', 'steps', 'tl-row', 'terms', 'why-cell', 'sub-head', 'tbl-wrap', 'price-was', 'footnote']) {
      expect(prompt).toContain(className)
      expect(DEFAULT_OFFER_TEMPLATE).toContain(className)
    }
    expect(prompt).toContain('<section class="sec" data-section>')
    expect(prompt).toContain('never add new <svg> artwork')
  })

  it('refine prompt carries the hard lock and placeholder rules', () => {
    const prompt = buildRefineSystemPrompt({ language: 'pl', companyName: 'Acme', extraInstructions: 'Be brief.' })
    expect(prompt).toContain('data-user-edited="1"')
    expect(prompt).toContain('__IMG_0__')
    expect(prompt).toContain('<html lang="pl">')
    expect(prompt).toContain('Be brief.')
    expect(prompt).toContain('<p class="kicker sec-label">LABEL</p>')
  })
})

describe('checklist extraction', () => {
  it('extracts bullets and strips emphasis', () => {
    expect(extractBulletPoints('* **Bold** item\n- plain\n1. numbered\n   + nested\nno bullet')).toEqual([
      'Bold item',
      'plain',
      'numbered',
      'nested',
    ])
  })

  it('extracts markdown tables', () => {
    const tables = extractMarkdownTables(`intro\n${table}\noutro`)
    expect(tables).toHaveLength(1)
    expect(tables[0].header).toEqual(['Item', 'Regular', 'Price'])
    expect(tables[0].rows).toHaveLength(2)
    expect(tables[0].raw).toBe(table)
  })

  it('ignores pipes without a separator row', () => {
    expect(extractMarkdownTables('| a | b |\n| c | d |')).toEqual([])
  })

  it('builds a cumulative checklist for bullets plus tables', () => {
    const text = `* one\n* two\n* three\n\n${table}`
    const checklist = buildCompletenessChecklist(text)
    expect(checklist).toContain('MANDATORY CHECKLIST')
    expect(checklist).toContain('MANDATORY TABLES')
    expect(checklist).toContain('CUMULATIVE: 3 bullet points + 2 table rows = 5')
  })

  it('returns an empty checklist for plain text', () => {
    expect(buildCompletenessChecklist('just a sentence')).toBe('')
    expect(buildCompletenessChecklist('* one\n* two')).toBe('')
  })
})

describe('user prompts', () => {
  it('wraps the brief verbatim', () => {
    const prompt = buildGenerateUserPrompt('Brief text', 'en')
    expect(prompt).toContain('TARGET LANGUAGE FOR THE OUTPUT HTML: ENGLISH')
    expect(prompt.endsWith('CLIENT BRIEF / GUIDELINES (verbatim - preserve every detail):\nBrief text')).toBe(true)
  })

  it('works without a language', () => {
    expect(buildGenerateUserPrompt('Brief')).not.toContain('TARGET LANGUAGE')
  })

  it('joins refine parts with separators', () => {
    const prompt = buildRefineUserPrompt('<html>__IMG_0__</html>', 'make it shorter', 'pl')
    expect(prompt).toContain('CURRENT OFFER HTML')
    expect(prompt).toContain('<html>__IMG_0__</html>')
    expect(prompt).toContain('FEEDBACK (apply verbatim, do not summarize):\nmake it shorter')
    expect(prompt).toContain('\n\n---\n\n')
  })
})
