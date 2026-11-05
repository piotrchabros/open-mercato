import {
  MAX_TRACKED_SECTIONS,
  SECTION_KEY_MAX_LENGTH,
  SECTION_LABEL_MAX_LENGTH,
  buildSectionKey,
  computeScrollPct,
  fitBeatBody,
  normalizeSectionLabel,
  slugifySectionLabel,
} from '../lib/tracker-sections'
import { trackingBeatSchema, type TrackingBeatInput } from '../data/validators'
import { TRACKING } from '../lib/constants'

const VIEW_KEY = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60'

function beat(sx: TrackingBeatInput['sx']): TrackingBeatInput {
  return { t: 'beat', seg: 'acme-2026-11-abcdefghijkl', key: VIEW_KEY, ms: 12000, sc: 40, sx }
}

function byteLength(body: TrackingBeatInput): number {
  return new TextEncoder().encode(JSON.stringify(body)).length
}

describe('normalizeSectionLabel', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeSectionLabel('  Zakres \n\t prac  ')).toBe('Zakres prac')
  })

  it('returns an empty string for missing input', () => {
    expect(normalizeSectionLabel(null)).toBe('')
    expect(normalizeSectionLabel(undefined)).toBe('')
    expect(normalizeSectionLabel('   ')).toBe('')
  })

  it('caps the label length', () => {
    expect(normalizeSectionLabel('a'.repeat(500))).toHaveLength(SECTION_LABEL_MAX_LENGTH)
  })
})

describe('slugifySectionLabel', () => {
  it('strips diacritics including Polish ł', () => {
    expect(slugifySectionLabel('Zażółć gęślą jaźń — Łódź')).toBe('zazolc-gesla-jazn-lodz')
  })

  it('falls back when nothing is left', () => {
    expect(slugifySectionLabel('!!!')).toBe('section')
    expect(slugifySectionLabel('')).toBe('section')
  })
})

describe('buildSectionKey', () => {
  it('prefixes the one-based index', () => {
    expect(buildSectionKey(0, 'Cennik pakietów')).toBe('1-cennik-pakietow')
    expect(buildSectionKey(4, '')).toBe('5-section')
  })

  it('stays within the schema key limit without a trailing dash', () => {
    const key = buildSectionKey(11, 'word '.repeat(40))
    expect(key.length).toBeLessThanOrEqual(SECTION_KEY_MAX_LENGTH)
    expect(key.endsWith('-')).toBe(false)
    expect(key.startsWith('12-word-')).toBe(true)
  })

  it('keeps duplicate headings distinct by index', () => {
    expect(buildSectionKey(1, 'FAQ')).not.toBe(buildSectionKey(2, 'FAQ'))
  })
})

describe('computeScrollPct', () => {
  it('computes the rounded percentage', () => {
    expect(computeScrollPct(500, 2000)).toBe(25)
  })

  it('clamps to 0..100', () => {
    expect(computeScrollPct(-100, 2000)).toBe(0)
    expect(computeScrollPct(5000, 2000)).toBe(100)
  })

  it('handles empty or invalid heights', () => {
    expect(computeScrollPct(500, 0)).toBe(0)
    expect(computeScrollPct(Number.NaN, 2000)).toBe(0)
  })
})

describe('fitBeatBody', () => {
  it('keeps small payloads intact, drops zero dwell and rounds ms', () => {
    const body = fitBeatBody(
      beat([
        { k: '1-intro', l: 'Intro', ms: 1500.6 },
        { k: '2-cennik', l: 'Cennik', ms: 0 },
      ]),
      TRACKING.MAX_BODY_BYTES,
    )
    expect(body.sx).toEqual([{ k: '1-intro', l: 'Intro', ms: 1501 }])
  })

  it('omits sx when no section has dwell', () => {
    const body = fitBeatBody(beat([{ k: '1-intro', l: 'Intro', ms: 0 }]), TRACKING.MAX_BODY_BYTES)
    expect(body.sx).toBeUndefined()
    expect(trackingBeatSchema.safeParse(body).success).toBe(true)
  })

  it('shrinks oversized payloads under the byte limit, keeping the longest-viewed sections in order', () => {
    const sections = Array.from({ length: 80 }, (_, index) => ({
      k: buildSectionKey(index, `Sekcja numer ${index} ${'ż'.repeat(30)}`),
      l: normalizeSectionLabel(`Sekcja numer ${index} ${'ż'.repeat(150)}`),
      ms: (index + 1) * 100,
    }))
    const body = fitBeatBody(beat(sections), TRACKING.MAX_BODY_BYTES)
    expect(byteLength(body)).toBeLessThanOrEqual(TRACKING.MAX_BODY_BYTES)
    expect(trackingBeatSchema.safeParse(body).success).toBe(true)
    const kept = body.sx ?? []
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(MAX_TRACKED_SECTIONS)
    expect(kept[kept.length - 1].ms).toBe(MAX_TRACKED_SECTIONS * 100)
    const msValues = kept.map((section) => section.ms)
    expect([...msValues].sort((left, right) => left - right)).toEqual(msValues)
  })
})
