import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  queueUnassignedCalcomTranscript,
  renderUnassignedTranscriptPreview,
  toUnassignedTranscriptDto,
} from '../lib/unassigned-transcripts'
import { CalcomUnassignedTranscript } from '../data/entities'
import { calcomBookingSchema, calcomNotetakerSchema, type CalcomBooking, type CalcomNotetaker } from '../lib/payload'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

const findOne = findOneWithDecryption as jest.Mock
const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const translate = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  params ? fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? '')) : fallback

function buildBooking(overrides: Record<string, unknown> = {}): CalcomBooking {
  return calcomBookingSchema.parse({
    uid: 'bk-1',
    title: '  ',
    startTime: '2026-11-01T10:00:00.000Z',
    endTime: '2026-11-01T10:30:00.000Z',
    source: 'ad_hoc',
    organizer: { email: 'owner@example.com', name: 'Owner' },
    attendees: [{ name: 'Ann', email: 'ann@example.com' }, { name: null, email: 'bob@example.com' }],
    ...overrides,
  })
}

function buildNotetaker(passageCount = 2, summaryStatus: 'READY' | 'FAILED' | null = 'READY'): CalcomNotetaker {
  return calcomNotetakerSchema.parse({
    version: 1,
    sessionId: 'sess-1',
    transcriptId: 'tr-1',
    language: 'en',
    completeness: 'COMPLETE',
    durationMs: 60000,
    passages: Array.from({ length: passageCount }, (_v, index) => ({
      index,
      speakerKey: 's1',
      speakerName: 'Ann',
      startMs: index * 1000,
      endMs: index * 1000 + 500,
      text: `line ${index}`,
    })),
    summary: summaryStatus ? { status: summaryStatus, overview: 'Overview text', keyPoints: ['kp'] } : null,
  })
}

function buildEm() {
  const em = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'new-id', ...data })),
    persist: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    fork: jest.fn(),
  }
  em.fork.mockReturnValue(em)
  return em
}

beforeEach(() => {
  findOne.mockReset()
})

describe('queueUnassignedCalcomTranscript', () => {
  it('creates a pending row with mapped fields', async () => {
    findOne.mockResolvedValue(null)
    const em = buildEm()
    const result = await queueUnassignedCalcomTranscript(
      em as never,
      scope,
      { booking: buildBooking(), notetaker: buildNotetaker(), organizerUserId: 'user-1' },
      'no_attendees',
      translate,
    )
    expect(result).toEqual({ id: 'new-id', duplicate: false })
    expect(em.flush).toHaveBeenCalledTimes(1)
    const data = em.create.mock.calls[0][1]
    expect(em.create.mock.calls[0][0]).toBe(CalcomUnassignedTranscript)
    expect(data).toMatchObject({
      ...scope,
      bookingUid: 'bk-1',
      transcriptId: 'tr-1',
      sessionId: 'sess-1',
      source: 'ad_hoc',
      title: 'Meeting',
      organizerEmail: 'owner@example.com',
      organizerUserId: 'user-1',
      participantsSummary: [{ name: 'Ann', email: 'ann@example.com' }, { name: null, email: 'bob@example.com' }],
      language: 'en',
      completeness: 'COMPLETE',
      durationMs: 60000,
      passageCount: 2,
      summaryStatus: 'READY',
      reason: 'no_attendees',
      status: 'pending',
    })
    expect(data.summaryText).toContain('Overview text')
    expect((data.meetingStartedAt as Date).toISOString()).toBe('2026-11-01T10:00:00.000Z')
    expect(Object.keys(data.payload as object)).toEqual(['booking', 'notetaker'])
  })

  it('returns duplicate without creating when the transcript already exists', async () => {
    findOne.mockResolvedValue({ id: 'existing-id' })
    const em = buildEm()
    const result = await queueUnassignedCalcomTranscript(
      em as never,
      scope,
      { booking: buildBooking(), notetaker: buildNotetaker(), organizerUserId: null },
      'no_matching_attendee',
      translate,
    )
    expect(result).toEqual({ id: 'existing-id', duplicate: true })
    expect(em.create).not.toHaveBeenCalled()
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('propagates flush errors', async () => {
    findOne.mockResolvedValue(null)
    const em = buildEm()
    em.flush.mockRejectedValue(new Error('boom'))
    await expect(
      queueUnassignedCalcomTranscript(
        em as never,
        scope,
        { booking: buildBooking(), notetaker: buildNotetaker(), organizerUserId: null },
        'no_attendees',
        translate,
      ),
    ).rejects.toThrow('boom')
  })

  it('stores summary text only when the summary is READY', async () => {
    findOne.mockResolvedValue(null)
    const em = buildEm()
    await queueUnassignedCalcomTranscript(
      em as never,
      scope,
      { booking: buildBooking({ title: 'Kickoff' }), notetaker: buildNotetaker(2, 'FAILED'), organizerUserId: null },
      'no_attendees',
      translate,
    )
    const data = em.create.mock.calls[0][1]
    expect(data.summaryStatus).toBe('FAILED')
    expect(data.summaryText).toBeNull()
    expect(data.title).toBe('Kickoff')
  })
})

function buildRow(passageCount = 2): CalcomUnassignedTranscript {
  const row = new CalcomUnassignedTranscript()
  Object.assign(row, {
    id: 'row-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    bookingUid: 'bk-1',
    transcriptId: 'tr-1',
    sessionId: 'sess-1',
    source: 'ad_hoc',
    title: 'Kickoff',
    meetingStartedAt: new Date('2026-11-01T10:00:00.000Z'),
    meetingEndedAt: new Date('2026-11-01T10:30:00.000Z'),
    participantsSummary: [{ name: 'Ann', email: 'ann@example.com' }],
    payload: { booking: buildBooking(), notetaker: buildNotetaker(passageCount) },
    reason: 'no_attendees',
    createdAt: new Date('2026-11-01T11:00:00.000Z'),
    updatedAt: new Date('2026-11-01T11:05:00.000Z'),
  })
  return row
}

describe('renderUnassignedTranscriptPreview', () => {
  it('renders the full text when within the line limit', () => {
    const preview = renderUnassignedTranscriptPreview(buildRow(2), translate)
    expect(preview.truncated).toBe(false)
    expect(preview.text).toContain('Kickoff')
    expect(preview.text).toContain('Ann: line 1')
  })

  it('truncates to maxLines', () => {
    const preview = renderUnassignedTranscriptPreview(buildRow(30), translate, 10)
    expect(preview.truncated).toBe(true)
    expect(preview.text.split('\n')).toHaveLength(10)
  })
})

describe('toUnassignedTranscriptDto', () => {
  it('maps to camelCase without payload or preview by default', () => {
    const dto = toUnassignedTranscriptDto(buildRow())
    expect(dto).toMatchObject({
      id: 'row-1',
      bookingUid: 'bk-1',
      title: 'Kickoff',
      participants: [{ name: 'Ann', email: 'ann@example.com' }],
      reason: 'no_attendees',
      status: 'pending',
      meetingStartedAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T11:05:00.000Z',
      resolvedAt: null,
      organizerEmail: null,
    })
    expect(dto).not.toHaveProperty('payload')
    expect(dto).not.toHaveProperty('transcriptPreview')
  })

  it('includes the preview when requested', () => {
    const dto = toUnassignedTranscriptDto(buildRow(30), { includePreview: true, translate, maxLines: 5 })
    expect(dto.transcriptPreview?.split('\n')).toHaveLength(5)
    expect(dto.transcriptPreviewTruncated).toBe(true)
  })
})
