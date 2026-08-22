import { createHash } from 'node:crypto'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import type { ConnectCase } from '../data/entities'

/**
 * Case access matrix.
 *
 * The rule the earlier design got wrong: an ordinary agent must see UNASSIGNED
 * Cases as well as their own, or a new agent's Inbox is permanently empty and
 * there is no way to pick up work.
 *
 * | Case state        | handler        | manager (`cases.view.all`) |
 * |-------------------|----------------|-----------------------------|
 * | unassigned        | read + claim   | read                        |
 * | assigned to self  | read + act     | read + act                  |
 * | assigned to other | **no access**  | read (+ act with `assign`)  |
 *
 * "No access" means an indistinguishable 404, not a 403: telling an agent that
 * a Case exists but belongs to someone else is itself information about the
 * organization's traffic.
 */

export const CONNECT_HANDLE_FEATURE = 'connect.inbox.handle'
export const CONNECT_VIEW_ALL_FEATURE = 'connect.cases.view.all'
export const CONNECT_ASSIGN_FEATURE = 'connect.cases.assign'
export const CONNECT_MANAGE_FEATURE = 'connect.cases.manage'

export type CaseActor = {
  userId: string
  tenantId: string
  organizationId: string
  /** Server-resolved effective features; may contain wildcard grants. */
  features: readonly string[]
}

export type CaseAccess = {
  /** May see the Case and read its thread. */
  canRead: boolean
  /** May reply, resolve or reopen. */
  canAct: boolean
  /** May claim an unassigned Case for themselves. */
  canClaim: boolean
  /** May assign, transfer or unassign. */
  canAssign: boolean
  /** May close (terminal). */
  canClose: boolean
}

function has(actor: CaseActor, feature: string): boolean {
  const grantedFeatures = Array.isArray(actor.features) ? [...actor.features] : []
  return authorizeFeatures([feature], { grantedFeatures })
}

export type CaseAccessSubject = Pick<
  ConnectCase,
  'tenantId' | 'organizationId' | 'assigneeUserId' | 'status'
>

export function evaluateCaseAccess(subject: CaseAccessSubject, actor: CaseActor): CaseAccess {
  const denied: CaseAccess = {
    canRead: false,
    canAct: false,
    canClaim: false,
    canAssign: false,
    canClose: false,
  }

  // Scope first, and absolutely: a Case in another tenant or a sibling
  // organization is not visible to any feature combination.
  if (subject.tenantId !== actor.tenantId) return denied
  if (subject.organizationId !== actor.organizationId) return denied

  const isHandler = has(actor, CONNECT_HANDLE_FEATURE)
  const seesAll = has(actor, CONNECT_VIEW_ALL_FEATURE)
  const canAssign = has(actor, CONNECT_ASSIGN_FEATURE)
  const canClose = has(actor, CONNECT_MANAGE_FEATURE)
  if (!isHandler && !seesAll && !canAssign && !canClose) return denied

  const unassigned = subject.assigneeUserId == null
  const isOwner = subject.assigneeUserId === actor.userId

  const canRead = seesAll || canAssign || canClose || (isHandler && (unassigned || isOwner))
  if (!canRead) return denied

  // Acting on someone else's Case is a supervisory override, so it needs the
  // assign feature and produces an audited reason. An owner acts on their own.
  const canAct = isOwner || (!unassigned ? canAssign : canAssign || (isHandler && unassigned))

  return {
    canRead: true,
    canAct,
    canClaim: unassigned && (isHandler || canAssign),
    canAssign,
    canClose,
  }
}

/**
 * Fingerprint of the access decision for one Case, embedded in thread cursors.
 *
 * A cursor must not outlive the assignment it was issued under: if a Case is
 * transferred away mid-read, continuing to page through its thread would keep
 * feeding an agent a conversation they can no longer see. Binding the epoch to
 * the assignee and the Case version makes that continuation fail closed.
 */
export function computeCaseAccessEpoch(subject: {
  id: string
  assigneeUserId?: string | null
  updatedAt: Date
}): string {
  return createHash('sha256')
    .update(`${subject.id}:${subject.assigneeUserId ?? 'unassigned'}:${subject.updatedAt.toISOString()}`)
    .digest('hex')
}
