import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { CommandBus } from '@open-mercato/shared/lib/commands/command-bus'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ReparentCaseInput } from '../data/validators'
import type { ReparentCaseResult } from '../commands/reparent-case'
import { CONNECT_REPARENT_CASE_COMMAND_ID } from '../commands/reparent-case'
import { caseMergedConflict, inboxNotFound } from './inbox-route-context'
import type { CaseActor } from './case-access'

const logger = createLogger('connect').child({ component: 'reparent-route' })

/**
 * Shared execution and result mapping for the split and merge endpoints.
 *
 * Both routes differ only in how they build the command input; everything after
 * that — running through the command bus, translating a domain result to a
 * status code, minting the undo token, running the guard's after-success
 * callbacks — is identical. Duplicating it would give the two operations subtly
 * different error contracts, which is the sort of drift an operator only
 * discovers when they need the error to be right.
 */

type GuardLike = { runAfterSuccess: () => Promise<void> }

export type ReparentRouteArgs = {
  container: AppContainer
  actor: CaseActor
  guard: GuardLike
  input: ReparentCaseInput
  /**
   * Required. The command bus derives the action-log actor and the interceptor
   * context from `ctx.auth`, so a runtime context without it would produce a log
   * row nobody can undo.
   */
  request: Request
}

export async function executeReparentRoute(args: ReparentRouteArgs): Promise<Response> {
  const { container, guard, input } = args

  let outcome: { result: ReparentCaseResult; logEntry: { undoToken?: string | null } | null }
  try {
    const commandBus = container.resolve('commandBus') as CommandBus
    const ctx: CommandRuntimeContext = {
      container: container as never,
      auth: await getAuthFromRequest(args.request),
      organizationScope: null,
      selectedOrganizationId: args.actor.organizationId,
      organizationIds: [args.actor.organizationId],
      request: args.request,
    }
    outcome = (await commandBus.execute(CONNECT_REPARENT_CASE_COMMAND_ID, {
      input,
      ctx,
    })) as typeof outcome
  } catch (err) {
    // A command interceptor that blocked deliberately owns its own status and
    // body; flattening it to a generic 500 would hide a business decision.
    const rejection = getCommandInterceptorHttpRejection(err)
    if (rejection) return NextResponse.json(rejection.body, { status: rejection.status })
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Case reparenting failed', { err, operation: input.operation })
    return NextResponse.json(
      { error: 'The case could not be reparented.', code: 'reparent_failed' },
      { status: 500 },
    )
  }

  const result = outcome.result
  switch (result.status) {
    case 'not_found':
      return inboxNotFound()
    case 'case_merged':
      return caseMergedConflict(result.canonicalCaseId)
    case 'forbidden':
      return NextResponse.json(
        {
          error: 'Merging cases for different customers needs the override permission.',
          code: 'override_required',
        },
        { status: 403 },
      )
    case 'customer_mismatch':
      return NextResponse.json(
        {
          error: 'These cases belong to different customers.',
          code: 'customer_mismatch',
          reason: result.reason,
        },
        { status: 422 },
      )
    case 'invalid_selection':
      return NextResponse.json(
        { error: 'That selection cannot be reparented.', code: 'invalid_selection', reason: result.reason },
        { status: 422 },
      )
    case 'invalid_state':
      return NextResponse.json(
        { error: 'That case is not in a state that can be reparented.', code: 'invalid_state', reason: result.reason },
        { status: 422 },
      )
    case 'conflict':
      return NextResponse.json(
        {
          error: 'record_conflict',
          code: 'optimistic_lock_conflict',
          caseId: result.caseId,
          currentUpdatedAt: result.currentUpdatedAt,
        },
        { status: 409 },
      )
    case 'command_key_conflict':
      return NextResponse.json(
        {
          error: 'record_conflict',
          code: 'command_key_conflict',
        },
        { status: 409 },
      )
    default:
      break
  }

  const body = {
    status: 'reparented' as const,
    operation: result.operation,
    reparentingId: result.reparentingId,
    sourceCaseId: result.sourceCaseId,
    destinationCaseId: result.destinationCaseId,
    movedConversationIds: result.movedConversationIds,
    movedConversationCount: result.movedConversationIds.length,
    sourceUpdatedAt: result.sourceUpdatedAt,
    destinationUpdatedAt: result.destinationUpdatedAt,
    idempotentReplay: result.idempotentReplay,
    // The token for the canonical audit-log undo endpoint. A replay has no new
    // log entry, so it carries `null` rather than a token that would reverse
    // nothing — the caller already has the original from its first response.
    undoToken: outcome.logEntry?.undoToken ?? null,
  }

  if (result.status === 'idempotent_replay') {
    return NextResponse.json({ ...body }, { status: 200 })
  }

  await guard.runAfterSuccess()
  return NextResponse.json(body, { status: 201 })
}

export function reparentOpenApiResponses(operation: 'split' | 'merge') {
  return [
    { status: 201, description: `Case ${operation} applied` },
    { status: 200, description: 'Idempotent replay of an earlier identical request' },
    { status: 400, description: 'No organization selected, or an invalid case id' },
    { status: 401, description: 'Unauthorized' },
    { status: 403, description: 'Missing the reparent or override feature' },
    { status: 404, description: 'Case or conversation not found, out of scope, or unreadable' },
    {
      status: 409,
      description:
        'A case changed since it was loaded, the source is already merged, or the command key was reused with a different payload',
    },
    { status: 422, description: 'Invalid body, selection, lifecycle state, or customer mismatch' },
  ]
}
