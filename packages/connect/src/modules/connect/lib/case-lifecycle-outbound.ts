import type { ConnectCaseStatus } from '../data/entities'

/**
 * The Case status after a CONFIRMED human outbound.
 *
 * Only a confirmed send moves the ball back to the customer. A failed or
 * unknown attempt deliberately does not, because the queue would then show work
 * as handed over when nothing actually reached them — the exact situation where
 * a Case goes quiet and nobody notices.
 *
 * `new` is left alone: an agent replying without claiming has not started
 * owning the Case, and silently advancing it would empty the triage queue.
 */
export function statusAfterFirstOutbound(current: ConnectCaseStatus): ConnectCaseStatus {
  return current === 'in_progress' ? 'waiting_customer' : current
}
