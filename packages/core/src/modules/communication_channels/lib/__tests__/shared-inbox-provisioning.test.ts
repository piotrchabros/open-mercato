import type { ChannelAdapterRegistry } from '../registry'
import {
  checkSharedMailboxEligibility,
  extractMailboxAddress,
  sharedInboxIntegrationId,
} from '../shared-inbox-provisioning'

/**
 * Provider eligibility is opt-in by design: inheriting it from `channelScope`
 * would silently widen a provider's blast radius. These tests pin that a
 * provider must declare `sharedMailbox: true` AND be an email provider.
 */

function registryWith(adapters: Array<Record<string, unknown>>): ChannelAdapterRegistry {
  return {
    get: (providerKey: string) => adapters.find((adapter) => adapter.providerKey === providerKey),
    list: () => adapters,
  } as unknown as ChannelAdapterRegistry
}

describe('checkSharedMailboxEligibility', () => {
  it('accepts an email provider that opted in', () => {
    const registry = registryWith([
      { providerKey: 'imap', channelType: 'email', sharedMailbox: true },
    ])
    const result = checkSharedMailboxEligibility(registry, 'imap')
    expect(result.eligible).toBe(true)
  })

  it('rejects an unknown provider', () => {
    const result = checkSharedMailboxEligibility(registryWith([]), 'imap')
    expect(result).toEqual({ eligible: false, reason: 'unknown_provider' })
  })

  it('rejects an email provider that did not opt in', () => {
    const registry = registryWith([{ providerKey: 'imap', channelType: 'email' }])
    expect(checkSharedMailboxEligibility(registry, 'imap')).toEqual({
      eligible: false,
      reason: 'not_shared_mailbox_capable',
    })
  })

  // Push providers are tenant infrastructure, not team mailboxes, even though
  // they are also stored with `user_id IS NULL`.
  it('rejects a non-email provider even when it opted in', () => {
    const registry = registryWith([
      { providerKey: 'fcm', channelType: 'push', sharedMailbox: true },
    ])
    expect(checkSharedMailboxEligibility(registry, 'fcm')).toEqual({
      eligible: false,
      reason: 'not_email',
    })
  })

  it('treats a truthy-but-not-true opt-in as no opt-in', () => {
    const registry = registryWith([
      { providerKey: 'imap', channelType: 'email', sharedMailbox: 'yes' },
    ])
    expect(checkSharedMailboxEligibility(registry, 'imap')).toEqual({
      eligible: false,
      reason: 'not_shared_mailbox_capable',
    })
  })
})

describe('extractMailboxAddress', () => {
  it('prefers fromAddress and normalizes to lower case for the dedup index', () => {
    expect(extractMailboxAddress({ fromAddress: 'Support@Example.COM' })).toBe('support@example.com')
  })

  it('falls back to email, then username', () => {
    expect(extractMailboxAddress({ email: 'team@example.com' })).toBe('team@example.com')
    expect(extractMailboxAddress({ username: 'team@example.com' })).toBe('team@example.com')
  })

  it('ignores non-address values so a login name never becomes a mailbox identity', () => {
    expect(extractMailboxAddress({ username: 'svc-support' })).toBeNull()
    expect(extractMailboxAddress({})).toBeNull()
  })
})

describe('sharedInboxIntegrationId', () => {
  // The credential row is keyed per organization, so two organizations in one
  // tenant can each own a Gmail shared inbox without overwriting each other.
  it('scopes the credential namespace to the owning organization', () => {
    expect(sharedInboxIntegrationId('gmail', 'org-a')).toBe('shared_inbox_gmail_org-a')
    expect(sharedInboxIntegrationId('gmail', 'org-a')).not.toBe(
      sharedInboxIntegrationId('gmail', 'org-b'),
    )
  })
})
