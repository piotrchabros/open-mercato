import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  CONNECT_REPARENT_CASE_COMMAND_ID,
  CONNECT_REPARENTING_RESOURCE_KIND,
  reparentCaseCommand,
  type ReparentCaseResult,
} from '../reparent-case'
import { REPARENT_SNAPSHOT_VERSION, type ReparentUndoPayload } from '../../lib/case-reparenting'
import { reparentCaseInputSchema } from '../../data/validators'

/**
 * The command's contract with the rest of the platform.
 *
 * Its database behaviour lives in the integration specs — this file pins the
 * wiring that a unit test can actually prove, and that has silently broken
 * before: the undo payload has to survive the action-log round trip, a rejected
 * attempt must not become an undoable log entry, and redo must refuse loudly
 * rather than replay a correction over a world that has moved on.
 */

const ACTOR = {
  userId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  features: ['connect.cases.reparent'],
}

const SOURCE_ID = '55555555-5555-4555-8555-555555555555'
const TARGET_ID = '66666666-6666-4666-8666-666666666666'
const CONVERSATION_ID = '77777777-7777-4777-8777-777777777777'

const SPLIT_INPUT = {
  operation: 'split' as const,
  sourceCaseId: SOURCE_ID,
  conversationIds: [CONVERSATION_ID],
  expectedSourceUpdatedAt: '2026-08-22T12:00:00.000Z',
  clientCommandKey: 'split-key-1',
  reason: 'Unrelated conversations',
  actor: ACTOR,
}

const UNDO_PAYLOAD: ReparentUndoPayload = {
  schemaVersion: REPARENT_SNAPSHOT_VERSION,
  reparentingId: '88888888-8888-4888-8888-888888888888',
  operation: 'split',
  sourceBefore: {
    schemaVersion: 1,
    id: SOURCE_ID,
    status: 'in_progress',
    priority: 'normal',
    assigneeUserId: null,
    channelId: 'channel-1',
    firstInboundAt: null,
    lastInboundAt: null,
    firstAssignedAt: null,
    firstOutboundSentAt: null,
    resolvedAt: null,
    closedAt: null,
    previousCaseId: null,
    mergedIntoCaseId: null,
    splitFromCaseId: null,
    slaGeneration: 3,
    lineageVersion: 0,
    updatedAt: '2026-08-22T12:00:00.000Z',
  },
  destinationBefore: null,
  sourcePostUpdatedAt: '2026-08-22T12:05:00.000Z',
  destinationPostUpdatedAt: '2026-08-22T12:05:00.000Z',
  itemCount: 1,
  payloadFingerprint: 'fingerprint-abc',
}

function successResult(): ReparentCaseResult {
  return {
    status: 'reparented',
    idempotentReplay: false,
    operation: 'split',
    reparentingId: UNDO_PAYLOAD.reparentingId,
    sourceCaseId: SOURCE_ID,
    destinationCaseId: TARGET_ID,
    movedConversationIds: [CONVERSATION_ID],
    sourceUpdatedAt: UNDO_PAYLOAD.sourcePostUpdatedAt,
    destinationUpdatedAt: UNDO_PAYLOAD.destinationPostUpdatedAt,
    undoPayload: UNDO_PAYLOAD,
  }
}

function buildLogArgs(result: ReparentCaseResult) {
  return { input: SPLIT_INPUT, result, ctx: {} as never, snapshots: {} }
}

describe('connect.case.reparent registration', () => {
  it('exposes exactly one undoable handler under the frozen command id', () => {
    expect(reparentCaseCommand.id).toBe('connect.case.reparent')
    expect(CONNECT_REPARENT_CASE_COMMAND_ID).toBe('connect.case.reparent')
    expect(reparentCaseCommand.isUndoable).toBe(true)
    expect(typeof reparentCaseCommand.execute).toBe('function')
    expect(typeof reparentCaseCommand.undo).toBe('function')
  })

  // Replaying a correction after an undo is not the same act as the original:
  // the situation the operator reviewed no longer exists. Refusing is safer
  // than silently re-running it.
  it('refuses redo with a structured 409 rather than replaying', () => {
    let thrown: unknown
    try {
      reparentCaseCommand.redo!({ input: SPLIT_INPUT, ctx: {} as never, logEntry: {} })
    } catch (err) {
      thrown = err
    }
    expect(isCrudHttpError(thrown)).toBe(true)
    expect((thrown as { status: number }).status).toBe(409)
    expect((thrown as { body: Record<string, unknown> }).body).toMatchObject({
      code: 'reparent_redo_unsupported',
    })
  })
})

describe('buildLog', () => {
  it('records the undo payload where extractUndoPayload can find it', async () => {
    const metadata = await reparentCaseCommand.buildLog!(buildLogArgs(successResult()))
    expect(metadata).toMatchObject({
      resourceKind: CONNECT_REPARENTING_RESOURCE_KIND,
      resourceId: UNDO_PAYLOAD.reparentingId,
      tenantId: ACTOR.tenantId,
      organizationId: ACTOR.organizationId,
      actorUserId: ACTOR.userId,
    })

    // The command bus stores `payload` as `commandPayload`; reading
    // `logEntry.payload` in an undo handler is always undefined and silently
    // no-ops the undo. This asserts the round trip the handler actually uses.
    const roundTripped = extractUndoPayload<ReparentUndoPayload>({
      commandPayload: metadata!.payload,
    })
    expect(roundTripped).toEqual(UNDO_PAYLOAD)
  })

  // A merge can move an unbounded number of conversations. Embedding them would
  // put an unbounded array in every action-log row.
  it('stores a count instead of the moved conversation inventory', async () => {
    const metadata = await reparentCaseCommand.buildLog!(buildLogArgs(successResult()))
    const undo = extractUndoPayload<ReparentUndoPayload>({ commandPayload: metadata!.payload })!
    expect(undo.itemCount).toBe(1)
    expect(undo).not.toHaveProperty('items')
  })

  // An undo token on a rejected attempt would hand the operator a button that
  // reverses somebody else's operation.
  it.each([
    ['a conflict', { status: 'conflict', caseId: SOURCE_ID, currentUpdatedAt: '2026-08-22T12:00:00.000Z' }],
    ['a not_found', { status: 'not_found' }],
    ['a customer mismatch', { status: 'customer_mismatch', reason: 'different_customer' }],
    ['a reused command key', { status: 'command_key_conflict' }],
  ] as const)('skips the action log for %s', async (_label, result) => {
    const metadata = await reparentCaseCommand.buildLog!(buildLogArgs(result as ReparentCaseResult))
    expect(metadata).toEqual({ skipLog: true })
  })

  // A replay performed nothing, so it must not mint a second undo token for an
  // operation that already has one.
  it('skips the action log for an idempotent replay', async () => {
    const replay: ReparentCaseResult = {
      ...successResult(),
      status: 'idempotent_replay',
      idempotentReplay: true,
    } as ReparentCaseResult
    expect(await reparentCaseCommand.buildLog!(buildLogArgs(replay))).toEqual({ skipLog: true })
  })
})

describe('undo', () => {
  // Guessing what an operation did, from a log row that cannot prove it, would
  // move customer conversations on the strength of corrupt data.
  it.each([
    ['an absent payload', {}],
    ['a payload from a future schema', { commandPayload: { undo: { ...UNDO_PAYLOAD, schemaVersion: 2 } } }],
    ['a payload naming no reparenting', { commandPayload: { undo: { ...UNDO_PAYLOAD, reparentingId: '' } } }],
  ] as const)('fails closed with 409 unsafe_undo for %s', async (_label, logEntry) => {
    const ctx = { container: { resolve: jest.fn() }, auth: null } as never
    await expect(
      reparentCaseCommand.undo!({ input: SPLIT_INPUT, ctx, logEntry: logEntry as never }),
    ).rejects.toMatchObject({ status: 409, body: { code: 'unsafe_undo' } })
  })

  it('refuses before touching storage when the scope cannot be resolved', async () => {
    const resolve = jest.fn()
    const ctx = {
      container: { resolve },
      auth: { sub: ACTOR.userId, tenantId: null },
      selectedOrganizationId: null,
    } as never
    await expect(
      reparentCaseCommand.undo!({
        input: SPLIT_INPUT,
        ctx,
        logEntry: { commandPayload: { undo: UNDO_PAYLOAD } } as never,
      }),
    ).rejects.toMatchObject({ status: 409, body: { details: { reason: 'scope_unavailable' } } })
    expect(resolve).not.toHaveBeenCalled()
  })

  // `audit_logs.undo_*` says the caller may undo their own action. It does not
  // say they may reparent Connect Cases — the domain grant is intersected here.
  it('refuses a caller without the Connect undo feature, before opening a transaction', async () => {
    const resolve = jest.fn((name: string) => {
      if (name === 'rbacService') {
        return { loadAcl: async () => ({ isSuperAdmin: false, features: ['connect.inbox.handle'], organizations: null }) }
      }
      throw new Error(`unexpected resolve of ${name}`)
    })
    const ctx = {
      container: { resolve },
      auth: { sub: ACTOR.userId, tenantId: ACTOR.tenantId, orgId: ACTOR.organizationId },
      selectedOrganizationId: ACTOR.organizationId,
    } as never

    await expect(
      reparentCaseCommand.undo!({
        input: SPLIT_INPUT,
        ctx,
        logEntry: { commandPayload: { undo: UNDO_PAYLOAD } } as never,
      }),
    ).rejects.toMatchObject({ status: 403, body: { code: 'feature_required' } })
    expect(resolve).toHaveBeenCalledWith('rbacService')
    expect(resolve).not.toHaveBeenCalledWith('em')
  })

  it('treats an unresolvable rbac service as no features rather than as a pass', async () => {
    const resolve = jest.fn((name: string) => {
      if (name === 'rbacService') throw new Error('unavailable')
      throw new Error(`unexpected resolve of ${name}`)
    })
    const ctx = {
      container: { resolve },
      auth: { sub: ACTOR.userId, tenantId: ACTOR.tenantId, orgId: ACTOR.organizationId },
      selectedOrganizationId: ACTOR.organizationId,
    } as never

    await expect(
      reparentCaseCommand.undo!({
        input: SPLIT_INPUT,
        ctx,
        logEntry: { commandPayload: { undo: UNDO_PAYLOAD } } as never,
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(resolve).not.toHaveBeenCalledWith('em')
  })
})

describe('input validation', () => {
  it('accepts a well-formed split request', () => {
    expect(reparentCaseInputSchema.parse(SPLIT_INPUT).operation).toBe('split')
  })

  it('defaults the merge override flag to false so it is never implicitly on', () => {
    const parsed = reparentCaseInputSchema.parse({
      operation: 'merge',
      sourceCaseId: SOURCE_ID,
      targetCaseId: TARGET_ID,
      expectedSourceUpdatedAt: '2026-08-22T12:00:00.000Z',
      expectedTargetUpdatedAt: '2026-08-22T12:00:00.000Z',
      clientCommandKey: 'merge-key-1',
      reason: 'Duplicate case',
      actor: ACTOR,
    })
    expect(parsed.operation === 'merge' && parsed.allowCustomerMismatch).toBe(false)
  })

  // `allowCustomerMismatch` exists only on merge: a split child always inherits
  // the source's customer, so there is nothing for it to override.
  it('drops an override flag smuggled into a split request', () => {
    const parsed = reparentCaseInputSchema.parse({ ...SPLIT_INPUT, allowCustomerMismatch: true })
    expect(parsed).not.toHaveProperty('allowCustomerMismatch')
  })

  it.each([
    ['a blank reason', { reason: '   ' }],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
    ['duplicate conversation ids', { conversationIds: [CONVERSATION_ID, CONVERSATION_ID] }],
    ['an empty selection', { conversationIds: [] }],
    ['a non-uuid source case', { sourceCaseId: 'not-a-uuid' }],
    ['an unparseable optimistic token', { expectedSourceUpdatedAt: 'yesterday' }],
    // The key lands in a unique index and in log context.
    ['a command key with unsafe characters', { clientCommandKey: 'key with spaces' }],
    ['an over-long command key', { clientCommandKey: 'k'.repeat(129) }],
  ] as const)('rejects %s', (_label, overrides) => {
    expect(() => reparentCaseInputSchema.parse({ ...SPLIT_INPUT, ...overrides })).toThrow()
  })

  it('rejects more than 100 conversations in one split', () => {
    const conversationIds = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    expect(() => reparentCaseInputSchema.parse({ ...SPLIT_INPUT, conversationIds })).toThrow()
  })
})
