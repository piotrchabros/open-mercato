import type { CalcomNotetaker } from './payload'
import { MAX_SUMMARY_COMMENT_CHARS } from './constants'

export type CalcomTranscriptSummary = {
  status: 'READY' | 'FAILED'
  language: string | null
  overview: string | null
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
}

export type CalcomTranscriptSegment = {
  speaker: string
  startMs: number
  endMs: number
  text: string
}

export type CalcomTranscript = {
  externalRecordingId: string
  transcriptId: string
  language: string | null
  completeness: 'COMPLETE' | 'PARTIAL' | 'TRUNCATED'
  durationMs: number
  text: string
  segments: CalcomTranscriptSegment[]
  participants: string[]
  summary: CalcomTranscriptSummary | null
}

export type CalcomSpeakerLabels = {
  unknownSpeaker: string
  unknownSpeakerNumbered: (n: number) => string
}

export type CalcomTranscriptLabels = CalcomSpeakerLabels & {
  fileHeader: string
  summaryHeading: string
  keyPoints: string
  decisions: string
  actionItems: string
  transcriptHeading: string
}

export type CalcomTranscriptHeader = {
  title: string
  startTime: string | null
}

const ITEM_TEXT_FIELDS = ['text', 'title', 'description', 'content'] as const

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result.length > 0 ? result : null
}

export function normaliseSummaryItems(items: unknown[]): string[] {
  const result: string[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      const text = trimmed(item)
      if (text) result.push(text)
      continue
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      for (const field of ITEM_TEXT_FIELDS) {
        const text = trimmed(record[field])
        if (text) {
          result.push(text)
          break
        }
      }
    }
  }
  return result
}

function normaliseSummary(summary: CalcomNotetaker['summary']): CalcomTranscriptSummary | null {
  if (!summary) return null
  return {
    status: summary.status,
    language: trimmed(summary.language),
    overview: trimmed(summary.overview),
    keyPoints: normaliseSummaryItems(summary.keyPoints ?? []),
    decisions: normaliseSummaryItems(summary.decisions ?? []),
    actionItems: normaliseSummaryItems(summary.actionItems ?? []),
  }
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

export function renderSummaryText(
  summary: CalcomTranscriptSummary,
  labels: Pick<CalcomTranscriptLabels, 'keyPoints' | 'decisions' | 'actionItems'>,
): string {
  const sections: string[] = []
  if (summary.overview) sections.push(summary.overview)
  const lists: Array<[string, string[]]> = [
    [labels.keyPoints, summary.keyPoints],
    [labels.decisions, summary.decisions],
    [labels.actionItems, summary.actionItems],
  ]
  for (const [heading, entries] of lists) {
    if (entries.length === 0) continue
    sections.push([`${heading}:`, ...entries.map((entry) => `- ${entry}`)].join('\n'))
  }
  return sections.join('\n\n')
}

export function normaliseNotetakerTranscript(
  bookingUid: string,
  notetaker: CalcomNotetaker,
  labels: CalcomSpeakerLabels,
): CalcomTranscript {
  const segments: CalcomTranscriptSegment[] = []
  const participants: string[] = []
  const passages = [...notetaker.passages].sort((a, b) => a.index - b.index)
  for (const passage of passages) {
    const text = trimmed(passage.text)
    if (!text) continue
    const name = trimmed(passage.speakerName)
    const speaker = name
      ?? (typeof passage.unknownSpeakerNumber === 'number'
        ? labels.unknownSpeakerNumbered(passage.unknownSpeakerNumber)
        : labels.unknownSpeaker)
    if (name && !participants.includes(name)) participants.push(name)
    segments.push({ speaker, startMs: passage.startMs, endMs: passage.endMs, text })
  }
  return {
    externalRecordingId: bookingUid,
    transcriptId: notetaker.transcriptId,
    language: trimmed(notetaker.language),
    completeness: notetaker.completeness ?? 'COMPLETE',
    durationMs: notetaker.durationMs ?? segments[segments.length - 1]?.endMs ?? 0,
    text: segments.map((segment) => segment.text).join('\n'),
    segments,
    participants,
    summary: normaliseSummary(notetaker.summary),
  }
}

export function renderTranscriptText(
  transcript: CalcomTranscript,
  header: CalcomTranscriptHeader,
  labels: CalcomTranscriptLabels,
): string {
  const headerLines = [labels.fileHeader, header.title]
  if (header.startTime) headerLines.push(header.startTime)
  if (transcript.language) headerLines.push(transcript.language)
  headerLines.push(transcript.completeness)
  const blocks = [headerLines.join('\n')]
  if (transcript.summary) {
    const summaryText = renderSummaryText(transcript.summary, labels)
    if (summaryText) blocks.push(`${labels.summaryHeading}\n\n${summaryText}`)
  }
  const lines = transcript.segments.map(
    (segment) => `[${formatTimestamp(segment.startMs)}] ${segment.speaker}: ${segment.text}`,
  )
  blocks.push([labels.transcriptHeading, '', ...lines].join('\n'))
  return blocks.join('\n\n')
}

export function truncateForComment(text: string, max: number = MAX_SUMMARY_COMMENT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
