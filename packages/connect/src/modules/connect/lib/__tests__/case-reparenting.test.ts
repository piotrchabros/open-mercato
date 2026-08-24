import {
  buildCaseSnapshot,
  computeReparentFingerprint,
  deterministicLockOrder,
  evaluateUndoSafety,
  foldInboundRange,
  instantsMatch,
  inverseOperation,
  lineageInstructionFor,
  normalizeReason,
  reparentEventType,
  validateCustomerAlignment,
  validateMerge,
  validateSplit,
  MAX_SPLIT_CONVERSATIONS,
  type ReparentCaseView,
  type ReparentConversationView,
  type SplitConversationCandidate,
  type UndoItemFingerprint,
} from '../case-reparenting'

/**
 * The reparenting decision layer.
 *
 * A wrong answer here moves one customer's conversation onto another customer's
 * Case, or reverses a correction over work nobody reviewed. Both are
 * disclosures, so every rule below is pinned in both directions: what it allows
 * AND what it must refuse.
 */

const NOW = new Date('2026-08-22T12:00:00.000Z')

function at(offsetMinutes: number): Date {
  return new Date(NOW.getTime() + offsetMinutes * 60_000)
}

function caseView(overrides: Partial<ReparentCaseView> = {}): ReparentCaseView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    status: 'in_progress',
    priority: 'normal',
    assigneeUserId: null,
    channelId: 'channel-source',
    customerKind: 'person',
    customerId: 'customer-1',
    firstInboundAt: at(-120),
    lastInboundAt: at(-10),
    firstAssignedAt: null,
    firstOutboundSentAt: null,
    resolvedAt: null,
    closedAt: null,
    previousCaseId: null,
    mergedIntoCaseId: null,
    splitFromCaseId: null,
    slaGeneration: 3,
    lineageVersion: 0,
    updatedAt: at(-5),
    ...overrides,
  }
}

function conversation(
  id: string,
  createdAtMinutes: number,
  channelId = 'channel-a',
): SplitConversationCandidate {
  return { id, channelId, createdAt: at(createdAtMinutes) }
}

const THREE_ACTIVE = [
  conversation('aaaaaaaa-0000-4000-8000-000000000001', -90, 'channel-a'),
  conversation('bbbbbbbb-0000-4000-8000-000000000002', -60, 'channel-b'),
  conversation('cccccccc-0000-4000-8000-000000000003', -30, 'channel-c'),
]

describe('validateSplit', () => {
  it('moves the selected conversations and leaves the source non-empty', () => {
    const result = validateSplit({
      source: caseView(),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[1].id],
    })
    expect(result).toEqual({
      ok: true,
      plan: {
        movedConversationIds: [THREE_ACTIVE[1].id],
        childStatus: 'in_progress',
        childChannelId: 'channel-b',
      },
    })
  })

  // The child's channel must describe the conversations it actually holds. The
  // source Case's own channel may belong to a conversation that stayed behind.
  it('derives the child channel from the earliest selected conversation, not the source case', () => {
    const result = validateSplit({
      source: caseView({ channelId: 'channel-source' }),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[2].id, THREE_ACTIVE[1].id],
    })
    expect(result.ok && result.plan.childChannelId).toBe('channel-b')
  })

  it('breaks a createdAt tie by id so the child channel is deterministic', () => {
    const tied = [
      conversation('dddddddd-0000-4000-8000-000000000004', -60, 'channel-late'),
      conversation('aaaaaaaa-0000-4000-8000-000000000001', -60, 'channel-early'),
      conversation('zzzz-keeper', -10, 'channel-keeper'),
    ]
    const result = validateSplit({
      source: caseView(),
      activeConversations: tied,
      requestedConversationIds: [tied[0].id, tied[1].id],
    })
    expect(result.ok && result.plan.childChannelId).toBe('channel-early')
  })

  it('starts the child as new when the source has not been worked yet', () => {
    const result = validateSplit({
      source: caseView({ status: 'new' }),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[0].id],
    })
    expect(result.ok && result.plan.childStatus).toBe('new')
  })

  it.each(['waiting_customer', 'resolved'] as const)(
    'starts the child as in_progress when the source is %s',
    (status) => {
      const result = validateSplit({
        source: caseView({ status }),
        activeConversations: THREE_ACTIVE,
        requestedConversationIds: [THREE_ACTIVE[0].id],
      })
      expect(result.ok && result.plan.childStatus).toBe('in_progress')
    },
  )

  // Splitting everything out is a merge wearing a different name, and it would
  // skip the merge path's target checks entirely.
  it('refuses a selection that would empty the source', () => {
    const result = validateSplit({
      source: caseView(),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: THREE_ACTIVE.map((row) => row.id),
    })
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'invalid_selection', reason: 'source_would_be_empty' },
    })
  })

  it('refuses an empty selection', () => {
    const result = validateSplit({
      source: caseView(),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [],
    })
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'invalid_selection', reason: 'empty_selection' },
    })
  })

  it('refuses duplicate ids rather than silently deduplicating them', () => {
    const result = validateSplit({
      source: caseView(),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[0].id, THREE_ACTIVE[0].id],
    })
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'invalid_selection', reason: 'duplicate_conversation' },
    })
  })

  it('refuses more than the batch limit', () => {
    const many = Array.from({ length: MAX_SPLIT_CONVERSATIONS + 1 }, (_, index) =>
      conversation(`conv-${index}`, -index),
    )
    const result = validateSplit({
      source: caseView(),
      activeConversations: [...many, conversation('keeper', 0)],
      requestedConversationIds: many.map((row) => row.id),
    })
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'invalid_selection', reason: 'too_many_conversations' },
    })
  })

  // A conversation on somebody else's Case and one that does not exist must be
  // the SAME answer, or the endpoint becomes a probe.
  it('reports a foreign or inactive conversation as not_found', () => {
    const result = validateSplit({
      source: caseView(),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: ['ffffffff-0000-4000-8000-00000000000f'],
    })
    expect(result).toEqual({ ok: false, rejection: { code: 'not_found' } })
  })

  it('refuses a closed source', () => {
    const result = validateSplit({
      source: caseView({ status: 'closed' }),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[0].id],
    })
    expect(result).toEqual({ ok: false, rejection: { code: 'invalid_state', reason: 'source_closed' } })
  })

  it('refuses an already-merged source and names its canonical target', () => {
    const result = validateSplit({
      source: caseView({ mergedIntoCaseId: 'target-9' }),
      activeConversations: THREE_ACTIVE,
      requestedConversationIds: [THREE_ACTIVE[0].id],
    })
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'case_merged', canonicalCaseId: 'target-9' },
    })
  })
})

describe('validateCustomerAlignment', () => {
  it('accepts two cases naming the same customer', () => {
    expect(
      validateCustomerAlignment(
        { customerKind: 'person', customerId: 'c1' },
        { customerKind: 'person', customerId: 'c1' },
      ),
    ).toBe('aligned')
  })

  it('rejects different customer ids', () => {
    expect(
      validateCustomerAlignment(
        { customerKind: 'person', customerId: 'c1' },
        { customerKind: 'person', customerId: 'c2' },
      ),
    ).toBe('different_customer')
  })

  // Same uuid under a different kind is a different record entirely.
  it('rejects the same id under a different customer kind', () => {
    expect(
      validateCustomerAlignment(
        { customerKind: 'person', customerId: 'c1' },
        { customerKind: 'company', customerId: 'c1' },
      ),
    ).toBe('different_customer')
  })

  // An unlinked Case is where a mis-matched identity lands. Treating it as
  // compatible-with-anything is exactly how one customer's thread reaches
  // another's agent.
  it.each([
    ['source', { customerKind: null, customerId: null }, { customerKind: 'person', customerId: 'c1' }],
    ['target', { customerKind: 'person', customerId: 'c1' }, { customerKind: null, customerId: null }],
    ['both', { customerKind: null, customerId: null }, { customerKind: null, customerId: null }],
  ] as const)('treats an unlinked %s as needing an override', (_label, source, target) => {
    expect(validateCustomerAlignment(source, target)).toBe('unlinked_case')
  })
})

describe('validateMerge', () => {
  const source = caseView({ id: 'source-1' })
  const target = caseView({ id: 'target-1' })

  it('accepts two live cases for the same customer', () => {
    expect(
      validateMerge({ source, target, allowCustomerMismatch: false, hasOverrideFeature: false }),
    ).toEqual({ ok: true })
  })

  it('refuses merging a case into itself', () => {
    expect(
      validateMerge({ source, target: source, allowCustomerMismatch: false, hasOverrideFeature: false }),
    ).toEqual({ ok: false, rejection: { code: 'invalid_selection', reason: 'same_case' } })
  })

  // Cross-scope is a 404, never a 403: a sibling organization's Case must be
  // indistinguishable from one that does not exist.
  it.each([
    ['tenant', { tenantId: 'tenant-2' }],
    ['organization', { organizationId: 'org-2' }],
  ] as const)('reports a cross-%s target as not_found', (_label, overrides) => {
    expect(
      validateMerge({
        source,
        target: caseView({ id: 'target-1', ...overrides }),
        allowCustomerMismatch: false,
        hasOverrideFeature: false,
      }),
    ).toEqual({ ok: false, rejection: { code: 'not_found' } })
  })

  it.each([
    ['a closed source', { source: caseView({ id: 'source-1', status: 'closed' }) }, 'source_closed'],
    ['a closed target', { target: caseView({ id: 'target-1', status: 'closed' }) }, 'target_closed'],
  ] as const)('refuses %s', (_label, overrides, reason) => {
    expect(
      validateMerge({
        source,
        target,
        allowCustomerMismatch: false,
        hasOverrideFeature: false,
        ...overrides,
      }),
    ).toEqual({ ok: false, rejection: { code: 'invalid_state', reason } })
  })

  it('refuses an already-merged source', () => {
    expect(
      validateMerge({
        source: caseView({ id: 'source-1', mergedIntoCaseId: 'elsewhere' }),
        target,
        allowCustomerMismatch: false,
        hasOverrideFeature: false,
      }),
    ).toEqual({ ok: false, rejection: { code: 'case_merged', canonicalCaseId: 'elsewhere' } })
  })

  // Merging INTO a historical Case would move live work onto something every
  // read surface already treats as read-only.
  it('refuses an already-merged target and names where it went', () => {
    expect(
      validateMerge({
        source,
        target: caseView({ id: 'target-1', mergedIntoCaseId: 'canonical-7' }),
        allowCustomerMismatch: false,
        hasOverrideFeature: false,
      }),
    ).toEqual({ ok: false, rejection: { code: 'case_merged', canonicalCaseId: 'canonical-7' } })
  })

  describe('customer safety', () => {
    const mismatched = caseView({ id: 'target-1', customerId: 'customer-2' })

    it('refuses a mismatch by default', () => {
      expect(
        validateMerge({
          source,
          target: mismatched,
          allowCustomerMismatch: false,
          hasOverrideFeature: true,
        }),
      ).toEqual({ ok: false, rejection: { code: 'customer_mismatch', reason: 'different_customer' } })
    })

    // Asking for the override without holding it must be a permission answer,
    // not a validation one — the operator needs to know who to ask.
    it('refuses the override when the caller lacks the feature', () => {
      expect(
        validateMerge({
          source,
          target: mismatched,
          allowCustomerMismatch: true,
          hasOverrideFeature: false,
        }),
      ).toEqual({ ok: false, rejection: { code: 'customer_mismatch', reason: 'override_required' } })
    })

    it('accepts the override when the caller holds the feature', () => {
      expect(
        validateMerge({
          source,
          target: mismatched,
          allowCustomerMismatch: true,
          hasOverrideFeature: true,
        }),
      ).toEqual({ ok: true })
    })

    it('accepts an unlinked case only under the override', () => {
      const unlinked = caseView({ id: 'target-1', customerKind: null, customerId: null })
      expect(
        validateMerge({ source, target: unlinked, allowCustomerMismatch: false, hasOverrideFeature: true }),
      ).toEqual({ ok: false, rejection: { code: 'customer_mismatch', reason: 'unlinked_case' } })
      expect(
        validateMerge({ source, target: unlinked, allowCustomerMismatch: true, hasOverrideFeature: true }),
      ).toEqual({ ok: true })
    })
  })
})

describe('computeReparentFingerprint', () => {
  const base = {
    operation: 'split',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    sourceCaseId: 'source-1',
    conversationIds: ['b', 'a'],
    expectedSourceUpdatedAt: '2026-08-22T12:00:00.000Z',
    reason: 'Wrongly grouped',
  } as const

  // A retry that reorders its array or pads its reason is the same correction.
  // Hashing it differently would turn an idempotent retry into a 409.
  it('is stable across conversation ordering and reason whitespace', () => {
    expect(computeReparentFingerprint({ ...base, conversationIds: ['a', 'b'] })).toBe(
      computeReparentFingerprint({ ...base, reason: '  Wrongly grouped  ' }),
    )
  })

  it('is stable across equivalent instant formats', () => {
    expect(
      computeReparentFingerprint({ ...base, expectedSourceUpdatedAt: '2026-08-22T14:00:00.000+02:00' }),
    ).toBe(computeReparentFingerprint(base))
  })

  it.each([
    ['a different conversation set', { conversationIds: ['a', 'c'] }],
    ['a different reason', { reason: 'Something else' }],
    ['a different source case', { sourceCaseId: 'source-2' }],
    ['a different organization', { organizationId: 'org-2' }],
  ] as const)('changes for %s', (_label, overrides) => {
    expect(computeReparentFingerprint({ ...base, ...overrides })).not.toBe(
      computeReparentFingerprint(base),
    )
  })

  it('never collides between a split and a merge', () => {
    const merge = computeReparentFingerprint({
      operation: 'merge',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      sourceCaseId: 'source-1',
      targetCaseId: 'target-1',
      expectedSourceUpdatedAt: '2026-08-22T12:00:00.000Z',
      expectedTargetUpdatedAt: '2026-08-22T12:00:00.000Z',
      reason: 'Wrongly grouped',
      allowCustomerMismatch: false,
    })
    expect(merge).not.toBe(computeReparentFingerprint(base))
  })

  it('changes when the override flag changes', () => {
    const withoutOverride = {
      operation: 'merge',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      sourceCaseId: 'source-1',
      targetCaseId: 'target-1',
      expectedSourceUpdatedAt: '2026-08-22T12:00:00.000Z',
      expectedTargetUpdatedAt: '2026-08-22T12:00:00.000Z',
      reason: 'Duplicate',
      allowCustomerMismatch: false,
    } as const
    expect(
      computeReparentFingerprint({ ...withoutOverride, allowCustomerMismatch: true }),
    ).not.toBe(computeReparentFingerprint(withoutOverride))
  })
})

describe('instantsMatch', () => {
  it('compares instants rather than strings', () => {
    expect(instantsMatch('2026-08-22T14:00:00.000+02:00', new Date('2026-08-22T12:00:00.000Z'))).toBe(true)
  })

  it('rejects a different instant', () => {
    expect(instantsMatch('2026-08-22T12:00:01.000Z', new Date('2026-08-22T12:00:00.000Z'))).toBe(false)
  })

  it('rejects an unparseable token instead of treating it as a match', () => {
    expect(instantsMatch('not-a-date', new Date('2026-08-22T12:00:00.000Z'))).toBe(false)
  })
})

describe('foldInboundRange', () => {
  // The target now owns the source's conversations, so its triage position must
  // reflect the newest traffic it is responsible for, and its history must not
  // appear to start after messages it contains.
  it('takes the earlier first inbound and the later last inbound', () => {
    expect(
      foldInboundRange(
        { firstInboundAt: at(-60), lastInboundAt: at(-30) },
        { firstInboundAt: at(-120), lastInboundAt: at(-10) },
      ),
    ).toEqual({ firstInboundAt: at(-120), lastInboundAt: at(-10) })
  })

  it('keeps the target values when the source has none', () => {
    expect(
      foldInboundRange(
        { firstInboundAt: at(-60), lastInboundAt: at(-30) },
        { firstInboundAt: null, lastInboundAt: null },
      ),
    ).toEqual({ firstInboundAt: at(-60), lastInboundAt: at(-30) })
  })

  it('adopts the source values when the target has none', () => {
    expect(
      foldInboundRange(
        { firstInboundAt: null, lastInboundAt: null },
        { firstInboundAt: at(-120), lastInboundAt: at(-10) },
      ),
    ).toEqual({ firstInboundAt: at(-120), lastInboundAt: at(-10) })
  })
})

describe('evaluateUndoSafety', () => {
  const sourcePost = at(0)
  const destinationPost = at(0)
  const conversationId = 'conv-1'

  function item(overrides: Partial<UndoItemFingerprint> = {}): UndoItemFingerprint {
    return {
      conversationId,
      toCaseId: 'destination-1',
      afterConversationUpdatedAt: at(0),
      lastMessageAtAtExecution: at(-10),
      ...overrides,
    }
  }

  function conversationState(
    overrides: Partial<ReparentConversationView> = {},
  ): Map<string, ReparentConversationView> {
    return new Map([
      [
        conversationId,
        {
          id: conversationId,
          currentCaseId: 'destination-1',
          lastMessageAt: at(-10),
          updatedAt: at(0),
          ...overrides,
        },
      ],
    ])
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      reparenting: { status: 'completed' as const, sourcePostUpdatedAt: sourcePost, destinationPostUpdatedAt: destinationPost },
      source: caseView({ id: 'source-1', updatedAt: sourcePost }),
      destination: caseView({ id: 'destination-1', updatedAt: destinationPost }),
      items: [item()],
      conversations: conversationState(),
      ...overrides,
    }
  }

  it('permits an undo while nothing has moved since', () => {
    expect(evaluateUndoSafety(input())).toEqual({ safe: true })
  })

  it('permits an undo that moved no conversations at all', () => {
    expect(evaluateUndoSafety(input({ items: [], conversations: new Map() }))).toEqual({ safe: true })
  })

  it('refuses to reverse an operation that was already reversed', () => {
    expect(
      evaluateUndoSafety(
        input({
          reparenting: {
            status: 'reversed' as const,
            sourcePostUpdatedAt: sourcePost,
            destinationPostUpdatedAt: destinationPost,
          },
        }),
      ),
    ).toEqual({ safe: false, reason: 'already_reversed' })
  })

  it.each([
    ['source', 'source', 'source_changed'],
    ['destination', 'destination', 'destination_changed'],
  ] as const)('refuses when the %s case changed after the operation', (_label, key, reason) => {
    expect(
      evaluateUndoSafety(
        input({ [key]: caseView({ id: `${key}-1`, updatedAt: at(5) }) }),
      ),
    ).toEqual({ safe: false, reason })
  })

  it.each([
    ['source', 'source'],
    ['destination', 'destination'],
  ] as const)('refuses when the %s case is gone', (_label, key) => {
    expect(evaluateUndoSafety(input({ [key]: null }))).toEqual({ safe: false, reason: 'case_missing' })
  })

  it('refuses when a moved conversation can no longer be found', () => {
    expect(evaluateUndoSafety(input({ conversations: new Map() }))).toEqual({
      safe: false,
      reason: 'conversation_missing',
    })
  })

  // Someone reparented it again. Putting it back would silently undo THAT
  // decision too.
  it('refuses when a moved conversation has since moved again', () => {
    expect(
      evaluateUndoSafety(input({ conversations: conversationState({ currentCaseId: 'somewhere-else' }) })),
    ).toEqual({ safe: false, reason: 'conversation_moved' })
  })

  it('refuses when a moved conversation was written to afterwards', () => {
    expect(
      evaluateUndoSafety(input({ conversations: conversationState({ updatedAt: at(3) }) })),
    ).toEqual({ safe: false, reason: 'conversation_changed' })
  })

  // The decisive case: a customer replied after the correction. Reversing now
  // would move their reply somewhere nobody chose.
  it('refuses when a customer replied after the operation', () => {
    expect(
      evaluateUndoSafety(
        input({ conversations: conversationState({ updatedAt: at(0), lastMessageAt: at(2) }) }),
      ),
    ).toEqual({ safe: false, reason: 'later_activity' })
  })

  it('treats a conversation that gained its first message as later activity', () => {
    expect(
      evaluateUndoSafety(
        input({
          items: [item({ lastMessageAtAtExecution: null })],
          conversations: conversationState({ lastMessageAt: at(2) }),
        }),
      ),
    ).toEqual({ safe: false, reason: 'later_activity' })
  })
})

describe('lineage vocabulary', () => {
  it.each([
    ['split', 'child_of_source', 'connect.case.split'],
    ['merge', 'source_into_target', 'connect.case.merged'],
    ['undo_split', 'inverse_of_reparenting', 'connect.case.reparenting_undone'],
    ['undo_merge', 'inverse_of_reparenting', 'connect.case.reparenting_undone'],
  ] as const)('maps %s to its instruction and event', (operation, instruction, eventType) => {
    expect(lineageInstructionFor(operation)).toBe(instruction)
    expect(reparentEventType(operation)).toBe(eventType)
  })

  it('names the inverse of each reversible operation', () => {
    expect(inverseOperation('split')).toBe('undo_split')
    expect(inverseOperation('merge')).toBe('undo_merge')
  })
})

describe('deterministicLockOrder', () => {
  // A→B and B→A racing must take the same two locks in the same order, or they
  // deadlock instead of queueing.
  it('sorts and deduplicates so opposing operations agree on an order', () => {
    expect(deterministicLockOrder(['b', 'a', 'b'])).toEqual(['a', 'b'])
    expect(deterministicLockOrder(['a', 'b'])).toEqual(deterministicLockOrder(['b', 'a']))
  })
})

describe('buildCaseSnapshot', () => {
  it('captures identifiers, enums and timestamps only', () => {
    const snapshot = buildCaseSnapshot(
      caseView({ id: 'case-9', assigneeUserId: 'user-3', lineageVersion: 4 }),
    )
    expect(snapshot).toEqual({
      schemaVersion: 1,
      id: 'case-9',
      status: 'in_progress',
      priority: 'normal',
      assigneeUserId: 'user-3',
      channelId: 'channel-source',
      firstInboundAt: at(-120).toISOString(),
      lastInboundAt: at(-10).toISOString(),
      firstAssignedAt: null,
      firstOutboundSentAt: null,
      resolvedAt: null,
      closedAt: null,
      previousCaseId: null,
      mergedIntoCaseId: null,
      splitFromCaseId: null,
      slaGeneration: 3,
      lineageVersion: 4,
      updatedAt: at(-5).toISOString(),
    })
  })

  // The snapshot is written to an audit row and read back by undo. Anything the
  // customer wrote must never reach it.
  it('carries no subject, wrap-up, display label or customer identifier', () => {
    const serialized = JSON.stringify(buildCaseSnapshot(caseView()))
    for (const forbidden of ['subject', 'wrapUp', 'displayLabel', 'customerId', 'customerKind']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})

describe('normalizeReason', () => {
  it('trims so a padded retry hashes identically', () => {
    expect(normalizeReason('  duplicate case  ')).toBe('duplicate case')
  })
})
