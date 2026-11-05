import type { TrackingBeatInput } from '../data/validators'

export type SectionDwell = { k: string; l: string; ms: number }

export const MAX_TRACKED_SECTIONS = 60
export const SECTION_KEY_MAX_LENGTH = 64
export const SECTION_LABEL_MAX_LENGTH = 120
const COMPACT_LABEL_LENGTH = 40
const FALLBACK_SLUG = 'section'

const TRANSLITERATIONS: Record<string, string> = { ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe' }

export function normalizeSectionLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, SECTION_LABEL_MAX_LENGTH).trim()
}

export function slugifySectionLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łđøßæœ]/g, (char) => TRANSLITERATIONS[char] ?? char)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : FALLBACK_SLUG
}

export function buildSectionKey(index: number, label: string): string {
  const key = `${index + 1}-${slugifySectionLabel(label)}`
  return key.slice(0, SECTION_KEY_MAX_LENGTH).replace(/-+$/, '')
}

export function computeScrollPct(visibleBottom: number, contentHeight: number): number {
  if (!Number.isFinite(visibleBottom) || !Number.isFinite(contentHeight) || contentHeight <= 0) return 0
  const pct = Math.round((visibleBottom / contentHeight) * 100)
  return Math.max(0, Math.min(100, pct))
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function fitBeatBody(body: TrackingBeatInput, maxBytes: number): TrackingBeatInput {
  const sections = (body.sx ?? [])
    .filter((section) => section.ms > 0)
    .slice(0, MAX_TRACKED_SECTIONS)
    .map((section) => ({ k: section.k, l: section.l, ms: Math.round(section.ms) }))
  const withSections = (sx: SectionDwell[]): TrackingBeatInput =>
    sx.length > 0 ? { ...body, sx } : { t: body.t, seg: body.seg, key: body.key, ms: body.ms, sc: body.sc }
  const fits = (candidate: TrackingBeatInput) => byteLength(JSON.stringify(candidate)) <= maxBytes

  const full = withSections(sections)
  if (fits(full)) return full

  const compact = sections.map((section) => ({ ...section, l: section.l.slice(0, COMPACT_LABEL_LENGTH) }))
  const ranked = compact
    .map((section, index) => ({ section, index }))
    .sort((left, right) => right.section.ms - left.section.ms || left.index - right.index)
  while (ranked.length > 0) {
    const kept = [...ranked].sort((left, right) => left.index - right.index).map((entry) => entry.section)
    const candidate = withSections(kept)
    if (fits(candidate)) return candidate
    ranked.pop()
  }
  return withSections([])
}
