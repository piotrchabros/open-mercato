import { createHash } from 'node:crypto'
import { DEFAULT_FIELD_MAPPING } from '../data/entities'
import type { FieldMappingEntry, GraphFormQuestion } from '../data/validators'
import { INTERACTION_BODY_MAX, PLATFORMS, type MetaPlatform } from './constants'

export type LeadAnswer = { name: string; values: string[] }

export type MappedLeadData = {
  person: {
    firstName?: string
    lastName?: string
    fullName?: string
    displayName?: string
    primaryEmail?: string
    primaryPhoneRaw?: string
    jobTitle?: string
    city?: string
  }
  company: { displayName?: string; domain?: string }
  personCustomFields: Record<string, string | string[]>
  companyCustomFields: Record<string, string | string[]>
  notes: { label: string; value: string }[]
  consents: { consentKey: string; consentText: string; isChecked: boolean }[]
  answers: { name: string; label: string; values: string[]; target: string }[]
}

export const DEFAULT_QUESTION_TARGETS: Record<string, string> = Object.fromEntries(
  DEFAULT_FIELD_MAPPING.map((row) => [row.questionKey, row.target]),
)

const UNCHECKED_TOKENS = new Set(['false', '0', 'no'])
const PERSON_TARGET_PREFIX = 'person.'
const COMPANY_TARGET_PREFIX = 'company.'
const CUSTOM_FIELD_MARKER = 'cf:'

export function buildDefaultFieldMapping(questions: GraphFormQuestion[]): FieldMappingEntry[] {
  return questions.map((question) => ({
    questionKey: question.key,
    target: DEFAULT_QUESTION_TARGETS[question.key] ?? 'note',
  }))
}

export function computeQuestionsFingerprint(questions: { key: string; type: string }[]): string {
  const canonical = [...questions]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((question) => `${question.key}:${question.type}`)
    .join(',')
  return createHash('sha256').update(canonical).digest('hex')
}

export function splitFullName(full: string): { firstName: string | null; lastName: string | null } {
  const trimmed = full.trim().replace(/\s+/g, ' ')
  if (!trimmed) return { firstName: null, lastName: null }
  const lastSpace = trimmed.lastIndexOf(' ')
  if (lastSpace < 0) return { firstName: trimmed, lastName: null }
  return { firstName: trimmed.slice(0, lastSpace), lastName: trimmed.slice(lastSpace + 1) }
}

export function parseGraphTime(value: string): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function normalizePlatform(value: unknown): MetaPlatform | null {
  if (typeof value !== 'string') return null
  const lowered = value.trim().toLowerCase()
  if ((PLATFORMS as readonly string[]).includes(lowered)) return lowered as MetaPlatform
  if (lowered === 'facebook') return 'fb'
  if (lowered === 'instagram') return 'ig'
  return null
}

function joinValues(values: string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(', ')
}

function isChecked(values: string[]): boolean {
  const meaningful = values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
  if (meaningful.length === 0) return false
  return !meaningful.every((value) => UNCHECKED_TOKENS.has(value))
}

function customFieldValue(values: string[]): string | string[] | null {
  const meaningful = values.map((value) => value.trim()).filter((value) => value.length > 0)
  if (meaningful.length === 0) return null
  return meaningful.length === 1 ? meaningful[0] : meaningful
}

export function applyMapping(
  fieldData: LeadAnswer[],
  mapping: FieldMappingEntry[],
  questions: GraphFormQuestion[],
): MappedLeadData {
  const targetByKey = new Map(mapping.map((entry) => [entry.questionKey, entry.target]))
  const labelByKey = new Map(questions.map((question) => [question.key, question.label]))
  const result: MappedLeadData = {
    person: {},
    company: {},
    personCustomFields: {},
    companyCustomFields: {},
    notes: [],
    consents: [],
    answers: [],
  }

  for (const answer of fieldData) {
    const target = targetByKey.get(answer.name) ?? 'note'
    const label = labelByKey.get(answer.name) || answer.name
    const joined = joinValues(answer.values)
    result.answers.push({ name: answer.name, label, values: answer.values, target })

    if (target === 'ignore') continue
    if (target === 'consent') {
      result.consents.push({ consentKey: answer.name, consentText: label, isChecked: isChecked(answer.values) })
      continue
    }
    if (!joined) continue
    if (target === 'note') {
      result.notes.push({ label, value: joined })
      continue
    }

    if (target.startsWith(PERSON_TARGET_PREFIX) || target.startsWith(COMPANY_TARGET_PREFIX)) {
      const isPerson = target.startsWith(PERSON_TARGET_PREFIX)
      const field = target.slice(isPerson ? PERSON_TARGET_PREFIX.length : COMPANY_TARGET_PREFIX.length)
      if (field.startsWith(CUSTOM_FIELD_MARKER)) {
        const customValue = customFieldValue(answer.values)
        if (customValue === null) continue
        const key = field.slice(CUSTOM_FIELD_MARKER.length)
        if (isPerson) result.personCustomFields[key] = customValue
        else result.companyCustomFields[key] = customValue
        continue
      }
      if (isPerson) {
        const person = result.person
        if (field === 'primaryEmail') person.primaryEmail = joined.toLowerCase()
        else if (field === 'primaryPhone') person.primaryPhoneRaw = joined
        else if (field === 'firstName') person.firstName = joined
        else if (field === 'lastName') person.lastName = joined
        else if (field === 'fullName') person.fullName = joined
        else if (field === 'displayName') person.displayName = joined
        else if (field === 'jobTitle') person.jobTitle = joined
        else if (field === 'city') person.city = joined
      } else if (field === 'displayName') {
        result.company.displayName = joined
      } else if (field === 'domain') {
        result.company.domain = joined
      }
    }
  }

  return result
}

function emailLocalPart(email: string | null): string | null {
  if (!email) return null
  const local = email.split('@')[0]?.trim()
  return local ? local : null
}

export function resolvePersonNames(
  mapped: MappedLeadData,
  email: string | null,
  fallbackLastName: string,
): { firstName: string; lastName: string } {
  const person = mapped.person
  let firstName = person.firstName?.trim() || null
  let lastName = person.lastName?.trim() || null
  const combined = person.fullName ?? person.displayName
  if ((!firstName || !lastName) && combined) {
    const split = splitFullName(combined)
    firstName = firstName ?? split.firstName
    lastName = lastName ?? split.lastName
  }
  const local = emailLocalPart(email)
  if (!firstName) firstName = local
  if (!lastName) lastName = firstName && firstName !== local ? local : null
  return {
    firstName: firstName ?? fallbackLastName,
    lastName: lastName ?? fallbackLastName,
  }
}

type InteractionBodyInput = {
  title: string
  answers: { name: string; label?: string; values: string[]; target?: string }[]
  source: {
    campaignName?: string | null
    adsetName?: string | null
    adName?: string | null
    formName?: string | null
    platform?: string | null
    isOrganic?: boolean | null
  }
  notes: { label: string; value: string }[]
  conflictNote?: string | null
  differing?: { field: string; value: string }[]
  notMatched?: boolean
  labels: Record<string, string>
}

export function buildInteractionBody(input: InteractionBodyInput): string {
  const { labels, source } = input
  const label = (key: string) => labels[key] ?? key
  const sourceLines = [
    source.campaignName ? `${label('campaign')}: ${source.campaignName}` : null,
    source.adsetName ? `${label('adset')}: ${source.adsetName}` : null,
    source.adName ? `${label('ad')}: ${source.adName}` : null,
    source.formName ? `${label('form')}: ${source.formName}` : null,
    source.platform ? `${label('platform')}: ${source.platform}` : null,
    source.isOrganic === null || source.isOrganic === undefined ? null : `${label('organic')}: ${source.isOrganic}`,
  ].filter((line): line is string => line !== null)

  const trailing: string[] = []
  if (sourceLines.length > 0) trailing.push([`${label('source')}:`, ...sourceLines].join('\n'))
  if (input.notMatched) trailing.push(label('notMatched'))
  if (input.conflictNote) trailing.push(`${label('conflict')}: ${input.conflictNote}`)
  if (input.differing && input.differing.length > 0) {
    trailing.push(
      [`${label('differing')}:`, ...input.differing.map((entry) => `${entry.field}: ${entry.value}`)].join('\n'),
    )
  }
  const trailingText = trailing.join('\n\n')

  const answerLines = input.answers
    .map((answer) => ({ name: answer.label || answer.name, value: joinValues(answer.values) }))
    .filter((answer) => answer.value.length > 0)
    .map((answer) => `${answer.name}: ${answer.value}`)

  const buildBody = (lines: string[]): string => {
    const sections: string[] = [input.title]
    if (lines.length > 0) sections.push([`${label('answers')}:`, ...lines].join('\n'))
    if (trailingText) sections.push(trailingText)
    return sections.join('\n\n')
  }

  const kept = [...answerLines]
  while (kept.length > 0 && buildBody(kept).length > INTERACTION_BODY_MAX) kept.pop()
  return buildBody(kept).slice(0, INTERACTION_BODY_MAX)
}

export function detectQuestionDrift(
  form: { questions: GraphFormQuestion[] },
  fieldData: LeadAnswer[],
): GraphFormQuestion[] {
  const known = new Set(form.questions.map((question) => question.key))
  const drift: GraphFormQuestion[] = []
  for (const answer of fieldData) {
    if (known.has(answer.name)) continue
    known.add(answer.name)
    drift.push({ key: answer.name, label: answer.name, type: 'CUSTOM' })
  }
  return drift
}
