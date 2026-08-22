/**
 * Inbound classification — should this message open or touch a Case at all?
 *
 * Connect does not parse headers itself. `communication_channels` Contract D
 * already classifies auto-responders and bounces from the raw envelope, which
 * is where the headers actually live; re-deriving them here would mean two
 * implementations disagreeing about the same message. This module turns that
 * classification, plus Connect's own loop guard, into one decision.
 *
 * Getting this wrong is the classic shared-inbox failure: an auto-reply opens a
 * Case, the Case's acknowledgement triggers the customer's vacation responder,
 * and the two systems mail each other until someone notices.
 */

export type InboundClassification = {
  isAutoResponder: boolean
  isBounce: boolean
  classificationReason: string | null
}

export type InboundDisposition =
  | { action: 'process' }
  | { action: 'suppress'; reason: 'auto_responder' | 'bounce' | 'rate_limited' }

export type ClassifyInboundInput = {
  classification: InboundClassification
  /** True when the composite suppression counter is already over its limit. */
  rateLimited: boolean
}

/**
 * Decide what to do with one inbound message.
 *
 * Suppressed traffic neither opens a Case nor triggers acknowledgement — but it
 * is still RECORDED (as a completed receipt with `suppressed` disposition), so
 * an operator can see what was dropped and why. Silently discarding it would
 * make a mis-tuned classifier invisible.
 */
export function classifyInbound(input: ClassifyInboundInput): InboundDisposition {
  if (input.classification.isBounce) return { action: 'suppress', reason: 'bounce' }
  if (input.classification.isAutoResponder) return { action: 'suppress', reason: 'auto_responder' }
  if (input.rateLimited) return { action: 'suppress', reason: 'rate_limited' }
  return { action: 'process' }
}

/**
 * Whether a disposition permits an automated acknowledgement to the sender.
 *
 * Separate from `classifyInbound` because the two questions diverge: a
 * legitimate message that could not be classified is still stored and worked,
 * but must not be auto-acknowledged if the suppression counter is unavailable
 * (see the ingest command). Acknowledging is the step that can create a loop.
 */
export function mayAcknowledge(disposition: InboundDisposition, suppressionAvailable: boolean): boolean {
  if (disposition.action !== 'process') return false
  // Fail closed for acknowledgement ONLY. A suppression backend outage must not
  // stop us storing a legitimate customer message — dropping real mail is worse
  // than skipping an auto-reply.
  return suppressionAvailable
}
