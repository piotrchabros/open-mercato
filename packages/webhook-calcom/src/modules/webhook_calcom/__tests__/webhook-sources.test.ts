import bookingCreated from './fixtures/booking-created.json'
import meetingEnded from './fixtures/meeting-ended.json'
import transcriptGenerated from './fixtures/transcript-generated.json'
import { webhookSources, CALCOM_MAX_BODY_BYTES } from '../webhook-sources'
import { CALCOM_SOURCE_KEY } from '../integration'
import { CALCOM_SIGNATURE_HEADER, computeCalcomSignature } from '../lib/signature'

type Body = Record<string, unknown>

describe('webhookSources', () => {
  const [source] = webhookSources

  it('declares a single calcom source', () => {
    expect(webhookSources).toHaveLength(1)
    expect(source.key).toBe(CALCOM_SOURCE_KEY)
    expect(source.key).toBe('calcom')
    expect(source.label).toBe('Cal.com')
  })

  it('requires a secret webhookSecret credential', () => {
    expect(source.credentialFields).toEqual([
      expect.objectContaining({ key: 'webhookSecret', secret: true, required: true }),
    ])
  })

  it('accepts bodies up to 2 MB', () => {
    expect(source.maxBodyBytes).toBe(CALCOM_MAX_BODY_BYTES)
    expect(CALCOM_MAX_BODY_BYTES).toBe(2 * 1024 * 1024)
  })

  it('verifies with the webhookSecret credential and the lower-cased route headers', async () => {
    const raw = JSON.stringify(bookingCreated)
    const headers = Object.fromEntries(
      new Headers({ 'X-Cal-Signature-256': computeCalcomSignature(raw, 'secret-1') }).entries(),
    )
    const request = { body: raw, headers, parsedBody: bookingCreated as Body }
    await expect(source.verifier(request, { webhookSecret: 'secret-1' })).resolves.toBe(true)
    await expect(source.verifier(request, { webhookSecret: 'secret-2' })).resolves.toBe(false)
    expect(headers[CALCOM_SIGNATURE_HEADER]).toBeDefined()
  })

  it('wires the event type extractor for enveloped and flat payloads', () => {
    expect(source.eventTypeExtractor(bookingCreated as Body, {})).toBe('BOOKING_CREATED')
    expect(source.eventTypeExtractor(meetingEnded as Body, {})).toBe('MEETING_ENDED')
    expect(source.eventTypeExtractor(transcriptGenerated as Body, {})).toBe('RECORDING_TRANSCRIPTION_GENERATED')
  })

  it('wires the message id extractor', () => {
    expect(source.messageIdExtractor?.(bookingCreated as Body, {})).toBe('calcom:BOOKING_CREATED:bk-uid-1:2026-11-04T09:00:00.000Z')
    expect(source.messageIdExtractor?.(meetingEnded as Body, {})).toBe('calcom:MEETING_ENDED:bk-uid-1')
    expect(source.messageIdExtractor?.(transcriptGenerated as Body, {})).toBe('calcom:transcript:22222222-2222-4222-8222-222222222222')
  })
})
