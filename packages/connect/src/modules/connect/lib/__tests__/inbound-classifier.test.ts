import { classifyInbound, mayAcknowledge } from '../inbound-classifier'

/**
 * Suppression exists to stop the classic shared-inbox loop: an auto-reply opens
 * a Case, the Case's acknowledgement triggers the customer's vacation
 * responder, and the two systems mail each other indefinitely.
 */

const clean = { isAutoResponder: false, isBounce: false, classificationReason: null }

describe('classifyInbound', () => {
  it('processes an ordinary message', () => {
    expect(classifyInbound({ classification: clean, rateLimited: false })).toEqual({ action: 'process' })
  })

  it('suppresses an auto-responder', () => {
    expect(
      classifyInbound({ classification: { ...clean, isAutoResponder: true }, rateLimited: false }),
    ).toEqual({ action: 'suppress', reason: 'auto_responder' })
  })

  it('suppresses a bounce', () => {
    expect(classifyInbound({ classification: { ...clean, isBounce: true }, rateLimited: false })).toEqual({
      action: 'suppress',
      reason: 'bounce',
    })
  })

  it('suppresses a sender over its rate limit', () => {
    expect(classifyInbound({ classification: clean, rateLimited: true })).toEqual({
      action: 'suppress',
      reason: 'rate_limited',
    })
  })

  // A bounce is the more actionable signal for an operator than "this also
  // looked automated", so it wins when a message is both.
  it('reports a bounce ahead of an auto-responder when both are flagged', () => {
    expect(
      classifyInbound({
        classification: { ...clean, isBounce: true, isAutoResponder: true },
        rateLimited: true,
      }),
    ).toEqual({ action: 'suppress', reason: 'bounce' })
  })
})

describe('mayAcknowledge', () => {
  it('allows acknowledgement for a processed message', () => {
    expect(mayAcknowledge({ action: 'process' }, true)).toBe(true)
  })

  it('never acknowledges a suppressed message', () => {
    expect(mayAcknowledge({ action: 'suppress', reason: 'auto_responder' }, true)).toBe(false)
  })

  // Fail closed for acknowledgement ONLY. The caller still stores the message —
  // dropping real customer mail because a counter was unavailable would be a
  // far worse outcome than skipping an auto-reply.
  it('withholds acknowledgement when the suppression counter is unavailable', () => {
    expect(mayAcknowledge({ action: 'process' }, false)).toBe(false)
  })
})
