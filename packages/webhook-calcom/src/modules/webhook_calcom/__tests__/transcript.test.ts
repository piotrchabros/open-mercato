import fixture from './fixtures/transcript-generated.json'
import { calcomNotetakerSchema } from '../lib/payload'
import {
  normaliseNotetakerTranscript,
  normaliseSummaryItems,
  renderSummaryText,
  renderTranscriptText,
  truncateForComment,
  type CalcomTranscriptLabels,
} from '../lib/transcript'

const labels: CalcomTranscriptLabels = {
  unknownSpeaker: 'Unknown speaker',
  unknownSpeakerNumbered: (n) => `Unknown speaker ${n}`,
  fileHeader: 'Meeting transcript',
  summaryHeading: 'Meeting summary',
  keyPoints: 'Key points',
  decisions: 'Decisions',
  actionItems: 'Action items',
  transcriptHeading: 'Transcript',
}

const notetaker = calcomNotetakerSchema.parse(fixture.payload.notetaker)

describe('normaliseNotetakerTranscript', () => {
  it('maps passages to ordered segments with labelled speakers', () => {
    const transcript = normaliseNotetakerTranscript('bk-uid-1', notetaker, labels)
    expect(transcript.externalRecordingId).toBe('bk-uid-1')
    expect(transcript.transcriptId).toBe(notetaker.transcriptId)
    expect(transcript.completeness).toBe('COMPLETE')
    expect(transcript.durationMs).toBe(1800000)
    expect(transcript.segments.map((s) => s.speaker)).toEqual(['Piotr Host', 'Anna Kowalska', 'Unknown speaker 1'])
    expect(transcript.participants).toEqual(['Piotr Host', 'Anna Kowalska'])
    expect(transcript.summary?.actionItems).toEqual(['Send proposal'])
  })

  it('carries TRUNCATED completeness through and renders it in the header', () => {
    const truncated = calcomNotetakerSchema.parse({ ...fixture.payload.notetaker, completeness: 'TRUNCATED' })
    const transcript = normaliseNotetakerTranscript('bk', truncated, labels)
    expect(transcript.completeness).toBe('TRUNCATED')
    const text = renderTranscriptText(transcript, { title: 'T', startTime: null }, labels)
    expect(text.split('\n\n')[0]).toContain('TRUNCATED')
  })

  it('degrades unknown completeness to PARTIAL', () => {
    const unknown = calcomNotetakerSchema.parse({ ...fixture.payload.notetaker, completeness: 'WEIRD' })
    expect(normaliseNotetakerTranscript('bk', unknown, labels).completeness).toBe('PARTIAL')
  })

  it('sorts by index, skips empty text and never leaks speakerKey', () => {
    const shuffled = calcomNotetakerSchema.parse({
      ...fixture.payload.notetaker,
      passages: [
        { index: 2, speakerKey: 'raw-b', speakerName: null, startMs: 5, endMs: 6, text: 'second' },
        { index: 1, speakerKey: 'raw-a', speakerName: null, unknownSpeakerNumber: 3, startMs: 1, endMs: 2, text: 'first' },
        { index: 3, speakerKey: 'raw-c', speakerName: 'X', startMs: 7, endMs: 8, text: '   ' },
      ],
    })
    const transcript = normaliseNotetakerTranscript('bk', shuffled, labels)
    expect(transcript.segments.map((s) => [s.speaker, s.text])).toEqual([
      ['Unknown speaker 3', 'first'],
      ['Unknown speaker', 'second'],
    ])
  })
})

describe('normaliseSummaryItems', () => {
  it('keeps strings, extracts object text fields and drops the rest', () => {
    expect(
      normaliseSummaryItems(['a', { text: 'b' }, { title: 'c' }, { description: 'd' }, { content: 'e' }, 5, null, {}, ' ']),
    ).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('rendering', () => {
  const transcript = normaliseNotetakerTranscript('bk-uid-1', notetaker, labels)

  it('renders the summary with bulleted sections', () => {
    const text = renderSummaryText(transcript.summary!, labels)
    expect(text).toContain('Intro call about pricing and onboarding.')
    expect(text).toContain('Key points:\n- Pricing discussed\n- Onboarding timeline')
    expect(text).toContain('Decisions:\n- Send proposal by Friday')
    expect(text).toContain('Action items:\n- Send proposal')
  })

  it('renders header, summary and timestamped lines', () => {
    const text = renderTranscriptText(transcript, { title: 'Discovery call', startTime: '2026-11-10T10:00:00Z' }, labels)
    expect(text.startsWith('Meeting transcript\nDiscovery call\n2026-11-10T10:00:00Z\nen\nCOMPLETE')).toBe(true)
    expect(text).toContain('Meeting summary')
    expect(text).toContain('[00:00:00] Piotr Host: Hi Anna, thanks for joining.')
    expect(text).toContain('[00:00:09] Unknown speaker 1: Sorry to interrupt')
  })

  it('omits the summary section when absent', () => {
    const text = renderTranscriptText({ ...transcript, summary: null }, { title: 'T', startTime: null }, labels)
    expect(text).not.toContain('Meeting summary')
  })
})

describe('truncateForComment', () => {
  it('leaves short text and truncates long text within the limit', () => {
    expect(truncateForComment('short', 10)).toBe('short')
    const result = truncateForComment('x'.repeat(50), 10)
    expect(result.length).toBe(10)
    expect(result.endsWith('…')).toBe(true)
  })
})
