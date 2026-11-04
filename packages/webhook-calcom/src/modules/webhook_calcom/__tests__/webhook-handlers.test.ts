import { matchWebhookEventPattern } from '@open-mercato/shared/lib/events/patterns'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { WebhookHandlerPayload } from '@open-mercato/shared/lib/webhooks'
import bookingCreated from './fixtures/booking-created.json'
import bookingCancelled from './fixtures/booking-cancelled.json'
import meetingEnded from './fixtures/meeting-ended.json'
import transcriptGenerated from './fixtures/transcript-generated.json'
import transcriptLegacyDaily from './fixtures/transcript-legacy-daily.json'
import {
  CALCOM_BOOKING_HANDLER_ID,
  CALCOM_MEETING_ENDED_HANDLER_ID,
  CALCOM_TRANSCRIPT_HANDLER_ID,
  webhookHandlers,
} from '../webhook-handlers'
import bookingHandler from '../webhook-handlers/booking'
import meetingEndedHandler from '../webhook-handlers/meeting-ended'
import transcriptHandler from '../webhook-handlers/transcript'
import { syncCalcomBooking } from '../lib/booking-sync'
import { attachCalcomTranscript } from '../lib/transcript-sync'
import { CALCOM_INTEGRATION_ID } from '../integration'

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(),
}))
jest.mock('../lib/booking-sync', () => ({
  syncCalcomBooking: jest.fn(),
}))
jest.mock('../lib/transcript-sync', () => ({
  attachCalcomTranscript: jest.fn(),
}))

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const credentials = {
  webhookSecret: 'secret-1',
  instanceUrl: 'https://cal.example.com',
  unmatchedAttendeePolicy: 'skip',
}

const createContainer = createRequestContainer as jest.Mock
const translations = resolveTranslations as jest.Mock
const syncBooking = syncCalcomBooking as jest.Mock
const attachTranscript = attachCalcomTranscript as jest.Mock

const ctx = { resolve: <T,>(name: string): T => { throw new Error(`unexpected ctx.resolve(${name})`) } }

function buildPayload(body: Record<string, unknown>, eventType: string): WebhookHandlerPayload {
  return {
    data: body,
    eventType,
    sourceKey: 'calcom',
    headers: {},
    ingestionId: '44444444-4444-4444-8444-444444444444',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  }
}

function buildHarness(options: { credentials?: Record<string, unknown> | null } = {}) {
  const resolveCredentials = jest.fn().mockResolvedValue(options.credentials === undefined ? credentials : options.credentials)
  const writeLog = jest.fn().mockResolvedValue(undefined)
  const services: Record<string, unknown> = {
    integrationCredentialsService: { resolve: resolveCredentials },
    integrationLogService: { write: writeLog },
  }
  const container = {
    resolve: (name: string) => {
      if (!(name in services)) throw new Error(`unexpected resolve(${name})`)
      return services[name]
    },
  }
  createContainer.mockResolvedValue(container)
  translations.mockResolvedValue({
    locale: 'en',
    translate: (_key: string, fallback: string) => `translated:${fallback}`,
  })
  syncBooking.mockResolvedValue({ action: 'created', interactionId: 'int-1' })
  attachTranscript.mockResolvedValue({ action: 'attached', attachmentId: 'att-1', interactionId: 'int-1' })
  return { container, resolveCredentials, writeLog }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('webhookHandlers registry', () => {
  it('declares the three calcom handlers', () => {
    expect(webhookHandlers.map((entry) => entry.meta)).toEqual([
      { source: 'calcom', event: 'BOOKING_*', id: CALCOM_BOOKING_HANDLER_ID },
      { source: 'calcom', event: 'MEETING_ENDED', id: CALCOM_MEETING_ENDED_HANDLER_ID },
      { source: 'calcom', event: 'RECORDING_TRANSCRIPTION_GENERATED', id: CALCOM_TRANSCRIPT_HANDLER_ID },
    ])
  })

  it('matches every booking trigger with the BOOKING_* prefix pattern only', () => {
    const [booking, meeting, transcript] = webhookHandlers
    for (const trigger of ['BOOKING_CREATED', 'BOOKING_REQUESTED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'BOOKING_REJECTED']) {
      expect(matchWebhookEventPattern(trigger, booking.meta.event)).toBe(true)
      expect(matchWebhookEventPattern(trigger, meeting.meta.event)).toBe(false)
      expect(matchWebhookEventPattern(trigger, transcript.meta.event)).toBe(false)
    }
    expect(matchWebhookEventPattern('MEETING_ENDED', booking.meta.event)).toBe(false)
    expect(matchWebhookEventPattern('MEETING_ENDED', meeting.meta.event)).toBe(true)
    expect(matchWebhookEventPattern('RECORDING_TRANSCRIPTION_GENERATED', transcript.meta.event)).toBe(true)
    expect(matchWebhookEventPattern('RECORDING_TRANSCRIPTION_GENERATED', booking.meta.event)).toBe(false)
  })

  it('lazily loads the handler modules', async () => {
    const [booking, meeting, transcript] = webhookHandlers
    await expect(booking.handler()).resolves.toEqual({ default: bookingHandler })
    await expect(meeting.handler()).resolves.toEqual({ default: meetingEndedHandler })
    await expect(transcript.handler()).resolves.toEqual({ default: transcriptHandler })
  })
})

describe('booking handler', () => {
  it('syncs the parsed booking with the scope credentials and a translated fallback title', async () => {
    const harness = buildHarness()
    await bookingHandler(buildPayload(bookingCreated as Record<string, unknown>, 'BOOKING_CREATED'), ctx)

    expect(createContainer).toHaveBeenCalledTimes(1)
    expect(harness.resolveCredentials).toHaveBeenCalledWith(CALCOM_INTEGRATION_ID, scope)
    expect(syncBooking).toHaveBeenCalledTimes(1)
    const [container, input] = syncBooking.mock.calls[0]
    expect(container).toBe(harness.container)
    expect(input).toEqual({
      trigger: 'BOOKING_CREATED',
      booking: expect.objectContaining({ uid: 'bk-uid-1' }),
      scope,
      credentials,
      fallbackTitle: 'translated:Meeting',
    })
    expect(harness.writeLog).not.toHaveBeenCalled()
  })

  it('passes the cancel trigger through unchanged', async () => {
    buildHarness()
    await bookingHandler(buildPayload(bookingCancelled as Record<string, unknown>, 'BOOKING_CANCELLED'), ctx)
    expect(syncBooking.mock.calls[0][1]).toEqual(expect.objectContaining({
      trigger: 'BOOKING_CANCELLED',
      booking: expect.objectContaining({ uid: 'bk-uid-2' }),
    }))
  })

  it('skips and logs when the scope has no usable credentials', async () => {
    const harness = buildHarness({ credentials: null })
    await bookingHandler(buildPayload(bookingCreated as Record<string, unknown>, 'BOOKING_CREATED'), ctx)

    expect(syncBooking).not.toHaveBeenCalled()
    expect(harness.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: CALCOM_INTEGRATION_ID,
        level: 'warn',
        code: 'calcom.booking.skipped',
        payload: expect.objectContaining({ trigger: 'BOOKING_CREATED', reason: 'credentials_missing' }),
      }),
      scope,
    )
  })

  it('treats invalid stored credentials as missing', async () => {
    const harness = buildHarness({ credentials: { webhookSecret: 'secret-1' } })
    await bookingHandler(buildPayload(bookingCreated as Record<string, unknown>, 'BOOKING_CREATED'), ctx)
    expect(syncBooking).not.toHaveBeenCalled()
    expect(harness.writeLog).toHaveBeenCalledTimes(1)
  })

  it('propagates sync failures so the ingestion is marked failed', async () => {
    buildHarness()
    syncBooking.mockRejectedValueOnce(new Error('[internal] boom'))
    await expect(
      bookingHandler(buildPayload(bookingCreated as Record<string, unknown>, 'BOOKING_CREATED'), ctx),
    ).rejects.toThrow('[internal] boom')
  })
})

describe('meeting-ended handler', () => {
  it('parses the flat payload and completes the booking', async () => {
    const harness = buildHarness()
    await meetingEndedHandler(buildPayload(meetingEnded as Record<string, unknown>, 'MEETING_ENDED'), ctx)

    expect(harness.resolveCredentials).toHaveBeenCalledWith(CALCOM_INTEGRATION_ID, scope)
    expect(syncBooking).toHaveBeenCalledTimes(1)
    const [container, input] = syncBooking.mock.calls[0]
    expect(container).toBe(harness.container)
    expect(input).toEqual({
      trigger: 'MEETING_ENDED',
      booking: expect.objectContaining({ uid: 'bk-uid-1', organizer: expect.objectContaining({ email: expect.any(String) }) }),
      scope,
      credentials,
      fallbackTitle: 'translated:Meeting',
    })
  })

  it('skips without credentials', async () => {
    const harness = buildHarness({ credentials: null })
    await meetingEndedHandler(buildPayload(meetingEnded as Record<string, unknown>, 'MEETING_ENDED'), ctx)
    expect(syncBooking).not.toHaveBeenCalled()
    expect(harness.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ trigger: 'MEETING_ENDED', reason: 'credentials_missing' }) }),
      scope,
    )
  })
})

describe('transcript handler', () => {
  it('attaches the notetaker transcript with the resolved translator', async () => {
    const harness = buildHarness()
    await transcriptHandler(
      buildPayload(transcriptGenerated as Record<string, unknown>, 'RECORDING_TRANSCRIPTION_GENERATED'),
      ctx,
    )

    expect(attachTranscript).toHaveBeenCalledTimes(1)
    const [container, input] = attachTranscript.mock.calls[0]
    expect(container).toBe(harness.container)
    expect(input.booking).toEqual(expect.objectContaining({ uid: 'bk-uid-1' }))
    expect(input.notetaker).toEqual(expect.objectContaining({ transcriptId: expect.any(String), passages: expect.any(Array) }))
    expect(input.scope).toEqual(scope)
    expect(input.credentials).toEqual(credentials)
    expect(input.translate('webhook_calcom.transcript.fileHeader', 'Meeting transcript')).toBe('translated:Meeting transcript')
    expect(harness.resolveCredentials).toHaveBeenCalledWith(CALCOM_INTEGRATION_ID, scope)
    expect(syncBooking).not.toHaveBeenCalled()
  })

  it('skips and logs when the scope has no usable credentials', async () => {
    const harness = buildHarness({ credentials: null })
    await transcriptHandler(
      buildPayload(transcriptGenerated as Record<string, unknown>, 'RECORDING_TRANSCRIPTION_GENERATED'),
      ctx,
    )
    expect(attachTranscript).not.toHaveBeenCalled()
    expect(harness.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        payload: expect.objectContaining({ trigger: 'RECORDING_TRANSCRIPTION_GENERATED', reason: 'credentials_missing' }),
      }),
      scope,
    )
  })

  it('is a no-op for legacy Daily transcripts without a notetaker block', async () => {
    buildHarness()
    await transcriptHandler(
      buildPayload(transcriptLegacyDaily as Record<string, unknown>, 'RECORDING_TRANSCRIPTION_GENERATED'),
      ctx,
    )
    expect(attachTranscript).not.toHaveBeenCalled()
    expect(createContainer).not.toHaveBeenCalled()
    expect(translations).not.toHaveBeenCalled()
  })
})
