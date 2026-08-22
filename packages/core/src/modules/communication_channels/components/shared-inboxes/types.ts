/**
 * Wire shapes for the shared-inbox administration page (Connect upstream
 * Contract E, AUTH-UP-UI-01). Mirrors the JSON returned by
 * `/api/communication_channels/shared-inboxes*`.
 *
 * No field here ever carries a provider secret or a credential reference — the
 * API never sends one.
 */

export type SharedInboxRow = {
  id: string
  displayName: string
  providerKey: string
  externalIdentifier: string | null
  status: string
  isActive: boolean
  projectionMode: string
  trafficEnabled: boolean
  ownershipFrozen: boolean
  activeMemberCount: number
  updatedAt: string | null
}

export type LegacyChannelRow = {
  id: string
  displayName: string
  providerKey: string
  externalIdentifier: string | null
  classification: string | null
}

export type EligibleProvider = {
  providerKey: string
  channelType: string
}

export type SharedInboxListResponse = {
  items?: SharedInboxRow[]
  legacyChannels?: LegacyChannelRow[]
  eligibleProviders?: EligibleProvider[]
}

export type SharedInboxMemberRow = {
  id: string
  userId: string
  isActive: boolean
  grantedByUserId: string | null
  revokedByUserId: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SharedInboxMembersResponse = {
  channelId?: string
  items?: SharedInboxMemberRow[]
}
