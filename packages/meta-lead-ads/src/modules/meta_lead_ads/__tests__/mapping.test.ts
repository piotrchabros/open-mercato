import {
  applyMapping,
  buildDefaultFieldMapping,
  buildInteractionBody,
  computeQuestionsFingerprint,
  detectQuestionDrift,
  parseGraphTime,
  resolvePersonNames,
  splitFullName,
} from '../lib/mapping'

const questions = [
  { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'budget', label: 'Budget', type: 'CUSTOM' },
]

describe('buildDefaultFieldMapping', () => {
  it('maps known keys and sends unknown keys to note', () => {
    expect(buildDefaultFieldMapping(questions)).toEqual([
      { questionKey: 'full_name', target: 'person.fullName' },
      { questionKey: 'email', target: 'person.primaryEmail' },
      { questionKey: 'budget', target: 'note' },
    ])
  })
})

describe('splitFullName', () => {
  it('splits on the last space', () => {
    expect(splitFullName('Anna Maria Kowalska')).toEqual({ firstName: 'Anna Maria', lastName: 'Kowalska' })
  })

  it('returns a single token as first name', () => {
    expect(splitFullName('Madonna')).toEqual({ firstName: 'Madonna', lastName: null })
  })
})

describe('applyMapping', () => {
  const mapping = buildDefaultFieldMapping(questions)

  it('trims and lowercases email, keeps unmapped answers as notes', () => {
    const mapped = applyMapping(
      [
        { name: 'email', values: ['  Jan@Example.COM '] },
        { name: 'budget', values: ['10k'] },
        { name: 'surprise', values: ['yes'] },
      ],
      mapping,
      questions,
    )
    expect(mapped.person.primaryEmail).toBe('jan@example.com')
    expect(mapped.notes).toEqual([
      { label: 'Budget', value: '10k' },
      { label: 'surprise', value: 'yes' },
    ])
  })

  it('records unchecked consents and ignores ignored answers', () => {
    const mapped = applyMapping(
      [
        { name: 'agree', values: ['no'] },
        { name: 'agree_two', values: [] },
        { name: 'secret', values: ['x'] },
      ],
      [
        { questionKey: 'agree', target: 'consent' },
        { questionKey: 'agree_two', target: 'consent' },
        { questionKey: 'secret', target: 'ignore' },
      ],
      [],
    )
    expect(mapped.consents).toEqual([
      { consentKey: 'agree', consentText: 'agree', isChecked: false },
      { consentKey: 'agree_two', consentText: 'agree_two', isChecked: false },
    ])
    expect(mapped.notes).toEqual([])
  })

  it('collects custom fields', () => {
    const mapped = applyMapping(
      [{ name: 'size', values: ['S', 'M'] }],
      [{ questionKey: 'size', target: 'person.cf:shirt' }],
      [],
    )
    expect(mapped.personCustomFields).toEqual({ shirt: ['S', 'M'] })
  })
})

describe('resolvePersonNames', () => {
  const build = (fullName: string | undefined) => applyMapping(
    fullName ? [{ name: 'full_name', values: [fullName] }] : [],
    buildDefaultFieldMapping(questions),
    questions,
  )

  it('splits the full name', () => {
    expect(resolvePersonNames(build('Jan Kowalski'), null, 'Lead')).toEqual({ firstName: 'Jan', lastName: 'Kowalski' })
  })

  it('takes the missing last name from the email local part', () => {
    expect(resolvePersonNames(build('Jan'), 'jkowal@example.com', 'Lead')).toEqual({
      firstName: 'Jan',
      lastName: 'jkowal',
    })
  })

  it('falls back to the localized literal without email', () => {
    expect(resolvePersonNames(build('Jan'), null, 'Lead')).toEqual({ firstName: 'Jan', lastName: 'Lead' })
  })
})

describe('buildInteractionBody', () => {
  const labels = { answers: 'Answers', source: 'Source', campaign: 'Campaign', organic: 'Organic' }

  it('renders every answer plus source lines', () => {
    const body = buildInteractionBody({
      title: 'Lead from Meta',
      answers: [
        { name: 'email', label: 'Email', values: ['a@b.pl'], target: 'person.primaryEmail' },
        { name: 'budget', values: ['10k'], target: 'note' },
      ],
      source: { campaignName: 'Spring', isOrganic: false },
      notes: [],
      labels,
    })
    expect(body).toContain('Email: a@b.pl')
    expect(body).toContain('budget: 10k')
    expect(body).toContain('Campaign: Spring')
    expect(body).toContain('Organic: false')
  })

  it('caps the body at 10000 characters and keeps source lines', () => {
    const body = buildInteractionBody({
      title: 'Lead from Meta',
      answers: [
        { name: 'a', values: ['first'], target: 'note' },
        { name: 'b', values: ['x'.repeat(20_000)], target: 'note' },
      ],
      source: { campaignName: 'Spring' },
      notes: [],
      labels,
    })
    expect(body.length).toBeLessThanOrEqual(10_000)
    expect(body).toContain('a: first')
    expect(body).not.toContain('b: ')
    expect(body).toContain('Campaign: Spring')
  })

  it('renders the not-matched line only when requested', () => {
    const input = {
      title: 'Lead from Meta',
      answers: [{ name: 'budget', values: ['10k'], target: 'note' }],
      source: {},
      notes: [],
      labels: { ...labels, notMatched: 'No match key was present' },
    }
    expect(buildInteractionBody({ ...input, notMatched: true })).toContain('No match key was present')
    expect(buildInteractionBody(input)).not.toContain('No match key was present')
  })
})

describe('computeQuestionsFingerprint', () => {
  it('is stable regardless of order and changes with type', () => {
    const first = computeQuestionsFingerprint(questions)
    expect(computeQuestionsFingerprint([...questions].reverse())).toBe(first)
    const changed = questions.map((question) => (question.key === 'budget' ? { ...question, type: 'EMAIL' } : question))
    expect(computeQuestionsFingerprint(changed)).not.toBe(first)
  })
})

describe('parseGraphTime and detectQuestionDrift', () => {
  it('parses a +0000 offset', () => {
    expect(parseGraphTime('2024-05-01T10:00:00+0000')?.toISOString()).toBe('2024-05-01T10:00:00.000Z')
    expect(parseGraphTime('garbage')).toBeNull()
  })

  it('returns new keys typed CUSTOM', () => {
    expect(detectQuestionDrift({ questions }, [{ name: 'email', values: [] }, { name: 'new_q', values: [] }])).toEqual([
      { key: 'new_q', label: 'new_q', type: 'CUSTOM' },
    ])
  })
})
