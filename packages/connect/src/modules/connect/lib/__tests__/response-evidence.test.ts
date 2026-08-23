import {
  CONNECT_RESPONSE_EVIDENCE_VERSION,
  computeResponseEvidence,
  resolvePrincipalKindsSoftly,
} from '../response-evidence'

/**
 * A false `human` is the one unrecoverable outcome here: it credits a person
 * who never read the customer's message. Every test below therefore pins a
 * branch that must fall back to `unknown` rather than one that may.
 */

const AUTHOR = '11111111-1111-4111-8111-111111111111'
const ACCEPTOR = '22222222-2222-4222-8222-222222222222'

describe('computeResponseEvidence', () => {
  it('credits a human only when a human wrote it', () => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'human_authored',
        authorPrincipalKind: 'human',
        acceptedByUserId: null,
        acceptedByPrincipalKind: null,
      }),
    ).toBe('human')
  })

  it.each(['system_bot', 'integration'] as const)('never credits a %s author', (kind) => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'human_authored',
        authorPrincipalKind: kind,
        acceptedByUserId: null,
        acceptedByPrincipalKind: null,
      }),
    ).toBe('unknown')
  })

  it('stays unknown when the author has no resolved classification', () => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'human_authored',
        authorPrincipalKind: null,
        acceptedByUserId: null,
        acceptedByPrincipalKind: null,
      }),
    ).toBe('unknown')
  })

  it('credits an accepted AI draft to the human who accepted it', () => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'ai_draft',
        authorPrincipalKind: 'system_bot',
        acceptedByUserId: ACCEPTOR,
        acceptedByPrincipalKind: 'human',
      }),
    ).toBe('human_accepted_ai')
  })

  it('leaves an unaccepted AI draft unknown', () => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'ai_draft',
        authorPrincipalKind: 'human',
        acceptedByUserId: null,
        acceptedByPrincipalKind: null,
      }),
    ).toBe('unknown')
  })

  it('rejects an acceptor id with no resolved human behind it', () => {
    // An id alone proves nothing — a service account can click approve.
    expect(
      computeResponseEvidence({
        contentOrigin: 'ai_draft',
        authorPrincipalKind: 'human',
        acceptedByUserId: ACCEPTOR,
        acceptedByPrincipalKind: null,
      }),
    ).toBe('unknown')
    expect(
      computeResponseEvidence({
        contentOrigin: 'ai_draft',
        authorPrincipalKind: 'human',
        acceptedByUserId: ACCEPTOR,
        acceptedByPrincipalKind: 'integration',
      }),
    ).toBe('unknown')
  })

  it('never credits automation, whoever triggered it', () => {
    expect(
      computeResponseEvidence({
        contentOrigin: 'automation',
        authorPrincipalKind: 'human',
        acceptedByUserId: ACCEPTOR,
        acceptedByPrincipalKind: 'human',
      }),
    ).toBe('unknown')
  })

  it('pins the rule-set version stored alongside every verdict', () => {
    expect(CONNECT_RESPONSE_EVIDENCE_VERSION).toBe(1)
  })
})

describe('resolvePrincipalKindsSoftly', () => {
  it('maps resolved records by user id', async () => {
    const container = {
      resolve: () => ({
        resolve: async () => [
          { userId: AUTHOR, kind: 'human' },
          { userId: ACCEPTOR, kind: 'system_bot' },
        ],
      }),
    }
    const kinds = await resolvePrincipalKindsSoftly(container, {
      tenantId: 'tenant',
      organizationId: 'org',
      userIds: [AUTHOR, ACCEPTOR],
    })
    expect(kinds.get(AUTHOR)).toBe('human')
    expect(kinds.get(ACCEPTOR)).toBe('system_bot')
  })

  it('degrades to empty when the reader is not registered at all', async () => {
    const container = {
      resolve: () => {
        throw new Error('AwilixResolutionError')
      },
    }
    await expect(
      resolvePrincipalKindsSoftly(container, {
        tenantId: 'tenant',
        organizationId: 'org',
        userIds: [AUTHOR],
      }),
    ).resolves.toEqual(new Map())
  })

  it('degrades to empty when the underlying facade fails', async () => {
    // The reply must still reach the customer; only the evidence is lost.
    const container = {
      resolve: () => ({
        resolve: async () => {
          throw new Error('auth facade unavailable')
        },
      }),
    }
    await expect(
      resolvePrincipalKindsSoftly(container, {
        tenantId: 'tenant',
        organizationId: 'org',
        userIds: [AUTHOR],
      }),
    ).resolves.toEqual(new Map())
  })

  it('does not call the reader when there is nobody to resolve', async () => {
    const resolve = jest.fn()
    const container = { resolve: () => ({ resolve }) }
    await resolvePrincipalKindsSoftly(container, {
      tenantId: 'tenant',
      organizationId: 'org',
      userIds: [],
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})
