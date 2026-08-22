import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Hub entities for the Communication Channels module.
 *
 * Cross-module references (e.g. `MessageChannelLink.messageId → messages.message.id`)
 * use plain `uuid` columns, NOT MikroORM `@ManyToOne` decorators. Project rule:
 * "No direct ORM relationships between modules — use foreign key IDs, fetch separately."
 * Cross-module links are declared in `data/extensions.ts` via `EntityExtension`.
 *
 * See SPEC-045d §2.2.
 */

// ── CommunicationChannel ──────────────────────────────────────

/**
 * Per-channel lifecycle status. Set by the polling worker / outbound subscriber
 * + the `markChannelRequiresReauth` command. Existing `isActive` remains for the
 * coarse admin enable/disable toggle; `status` is the finer-grained operational
 * state used by per-user reconnect flows.
 *
 * Email integration spec § Hub Deltas → Delta 2.
 */
export type CommunicationChannelStatus =
  | 'connected'
  | 'requires_reauth'
  | 'error'
  | 'disconnected'

/**
 * Who owns Customer-timeline projection for a channel's traffic.
 *
 * - `legacy_customers` — the pre-existing `customers` message subscribers
 *   (`link-channel-message-received` / `-sent`) create CustomerInteraction rows
 *   directly. This is the default and covers every channel that existed before
 *   Connect.
 * - `connect_managed` — Connect exclusively owns identity resolution, Customer
 *   timeline projection, and retraction for this channel; the legacy customers
 *   subscribers skip it entirely.
 *
 * A channel can never be observed by both owners, so the value is immutable
 * once the channel has seen any message or delivery. Changing it afterwards
 * requires an audited history migration that is out of Phase 1 scope.
 *
 * Connect upstream Contract E.
 */
export type ChannelProjectionMode = 'legacy_customers' | 'connect_managed'

/** See {@link CommunicationChannel.legacySharedClassification}. */
export type LegacySharedChannelClassification =
  | 'tenant_push_infrastructure'
  | 'email_requires_reprovision'

@Entity({ tableName: 'communication_channels' })
@Index({ name: 'communication_channels_tenant_provider_idx', properties: ['tenantId', 'providerKey'] })
// Provider-push webhooks (Gmail Pub/Sub) resolve channels by (provider_key,
// external_identifier) WITHOUT a tenant_id — they only know the mailbox address.
// Without this index that lookup is a full scan over every channel of the
// provider, which a (signature-verified) push or replay repeats on every hit.
@Index({
  name: 'communication_channels_provider_external_idx',
  expression:
    `create index "communication_channels_provider_external_idx" on "communication_channels" ("provider_key", "external_identifier") where "deleted_at" is null`,
})
@Index({ name: 'communication_channels_tenant_type_active_idx', properties: ['tenantId', 'channelType', 'isActive'] })
@Index({
  name: 'communication_channels_user_lookup_idx',
  properties: ['userId', 'channelType', 'deletedAt'],
})
@Index({
  name: 'communication_channels_poll_due_idx',
  expression:
    `create index "communication_channels_poll_due_idx" on "communication_channels" ("is_active", "last_polled_at") where "deleted_at" is null`,
})
@Index({
  name: 'communication_channels_one_primary_per_user_uq',
  expression:
    `create unique index "communication_channels_one_primary_per_user_uq" on "communication_channels" ("user_id") where "is_primary" and "user_id" is not null and "deleted_at" is null`,
})
// One channel per (tenant, user, provider, mailbox): a reconnect heals the
// existing row in place (see `createConnectedChannelRow`) instead of inserting a
// duplicate that would stay polled + keep its own push subscription. Partial so
// tenant-wide channels (null user_id) and identifier-less rows are exempt.
@Index({
  name: 'communication_channels_user_provider_external_uq',
  expression:
    `create unique index "communication_channels_user_provider_external_uq" on "communication_channels" ("tenant_id", "user_id", "provider_key", "external_identifier") where "deleted_at" is null and "user_id" is not null and "external_identifier" is not null`,
})
// One tenant-wide push channel per (tenant, provider): push providers (FCM/APNs/
// Expo) have no `external_identifier` and `user_id IS NULL`, so the mailbox
// unique index above does not cover them. This keeps an admin reconnect healing
// the single shared row (see `createConnectedChannelRow`) instead of inserting
// duplicates the fan-out would silently ignore.
@Index({
  name: 'communication_channels_tenant_push_provider_uq',
  expression:
    `create unique index "communication_channels_tenant_push_provider_uq" on "communication_channels" ("tenant_id", "provider_key") where "channel_type" = 'push' and "user_id" is null and "deleted_at" is null`,
})
// Shared inboxes are organization-owned team mailboxes: exactly one non-null
// owning organization and no personal owner. Enforced in the database so no
// code path — migration, admin route, or provisioning service — can produce a
// shared channel whose authorization scope is ambiguous (Contract E invariant
// "a shared channel has exactly one tenant+organization owner scope").
@Check({
  name: 'communication_channels_shared_inbox_scope_chk',
  expression: `not "is_shared_inbox" or ("organization_id" is not null and "user_id" is null)`,
})
@Check({
  name: 'communication_channels_projection_mode_chk',
  expression: `"projection_mode" in ('legacy_customers', 'connect_managed')`,
})
// Connect projection only ever applies to an organization-owned shared inbox;
// a personal or tenant-infrastructure channel can never be `connect_managed`.
@Check({
  name: 'communication_channels_connect_managed_shared_chk',
  expression: `"projection_mode" = 'legacy_customers' or "is_shared_inbox"`,
})
@Check({
  name: 'communication_channels_legacy_classification_chk',
  expression:
    `"legacy_shared_classification" is null or "legacy_shared_classification" in ('tenant_push_infrastructure', 'email_requires_reprovision')`,
})
// The shared-inbox admin list enumerates by (tenant, organization) — index it
// so a tenant with many personal mailboxes does not scan them all.
@Index({
  name: 'communication_channels_shared_inbox_idx',
  expression:
    `create index "communication_channels_shared_inbox_idx" on "communication_channels" ("tenant_id", "organization_id") where "is_shared_inbox" and "deleted_at" is null`,
})
// One shared inbox per (tenant, organization, provider, mailbox). The per-user
// heal index above is partial on `user_id is not null`, so it does not cover
// shared inboxes; without this a concurrent double-provision would create two
// channels polling the same mailbox and every message would be ingested twice.
@Index({
  name: 'communication_channels_shared_mailbox_uq',
  expression:
    `create unique index "communication_channels_shared_mailbox_uq" on "communication_channels" ("tenant_id", "organization_id", "provider_key", "external_identifier") where "is_shared_inbox" and "deleted_at" is null and "external_identifier" is not null`,
})
export class CommunicationChannel {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'isActive'
    | 'capabilities'
    | 'deletedAt'
    | 'externalIdentifier'
    | 'credentialsRef'
    | 'organizationId'
    | 'userId'
    | 'isPrimary'
    | 'pollIntervalSeconds'
    | 'lastPolledAt'
    | 'status'
    | 'lastError'
    | 'channelState'
    | 'isSharedInbox'
    | 'projectionMode'
    | 'ownershipFrozenAt'
    | 'trafficEnabledAt'
    | 'connectCapabilitySnapshot'
    | 'legacySharedClassification'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'provider_key', type: 'text' })
  providerKey!: string

  @Property({ name: 'channel_type', type: 'text' })
  channelType!: string

  @Property({ name: 'display_name', type: 'text' })
  displayName!: string

  @Property({ name: 'external_identifier', type: 'text', nullable: true })
  externalIdentifier?: string | null

  @Property({ name: 'credentials_ref', type: 'uuid', nullable: true })
  credentialsRef?: string | null

  @Property({ name: 'capabilities', type: 'json', nullable: true })
  capabilities?: Record<string, unknown> | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  /**
   * Per-user channel owner. NULL = tenant-scoped (existing behaviour, e.g. WhatsApp Business).
   * Set = user-scoped (e.g. Jane's personal Gmail). Visible only to the owning user
   * and to admins with `communication_channels.admin`. Linked to `auth:user` via
   * `EntityExtension` in `data/extensions.ts` — never a raw DB FK.
   */
  @Property({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string | null

  /**
   * Per-user "primary" flag. Only meaningful when `userId IS NOT NULL`; ignored
   * for tenant-scoped channels. Enforced as one-primary-per-user by the partial
   * unique index `communication_channels_one_primary_per_user_uq`.
   */
  @Property({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary: boolean = false

  /**
   * Polling cadence in seconds. NULL means "this channel does not poll" — i.e. it
   * is push-only (webhook) or its provider opted out via
   * `ChannelCapabilities.realtimePush !== false`. Set means hub-managed polling
   * at that interval via the `poll-tick` scheduler entry.
   */
  @Property({ name: 'poll_interval_seconds', type: 'int', nullable: true })
  pollIntervalSeconds?: number | null

  /** Last successful poll timestamp; the scheduler enumerates by this column. */
  @Property({ name: 'last_polled_at', type: Date, nullable: true })
  lastPolledAt?: Date | null

  /**
   * Per-channel lifecycle status. See {@link CommunicationChannelStatus}.
   * Migration sets `status = 'connected'` for all existing active channels (default value).
   */
  @Property({ name: 'status', type: 'text', default: 'connected' })
  status: CommunicationChannelStatus = 'connected'

  /** Most recent classified error message for diagnostics. */
  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  /**
   * Provider-specific resumption state, opaque to the hub. Polling adapters
   * encode their incremental cursor here (Gmail historyId, IMAP
   * UIDVALIDITY+UIDNEXT). The polling worker reads it before each
   * `fetchHistory` call and writes the adapter's returned `nextCursor` back
   * after a successful poll. Empty / NULL means "bootstrap on next poll".
   */
  @Property({ name: 'channel_state', type: 'json', nullable: true })
  channelState?: Record<string, unknown> | null

  /**
   * Marks an organization-owned shared team inbox (Contract E). Implies
   * `organizationId` is set and `userId` is null — enforced by
   * `communication_channels_shared_inbox_scope_chk`.
   *
   * Legacy tenant-wide channels (`user_id IS NULL AND organization_id IS NULL`,
   * e.g. FCM/APNs/Expo push infrastructure) keep `false` and their existing
   * tenant-wide semantics; they are NOT shared inboxes.
   */
  @Property({ name: 'is_shared_inbox', type: 'boolean', default: false })
  isSharedInbox: boolean = false

  /** See {@link ChannelProjectionMode}. Immutable once the channel has traffic. */
  @Property({ name: 'projection_mode', type: 'text', default: 'legacy_customers' })
  projectionMode: ChannelProjectionMode = 'legacy_customers'

  /**
   * Set the moment the owning organization becomes immutable — the first time a
   * membership, credential, conversation, or delivery exists for the channel.
   * Before it is set, an admin may still reassign ownership (which atomically
   * revokes and audits memberships); afterwards reassignment is rejected and
   * rehoming requires a fenced history migration outside Phase 1.
   */
  @Property({ name: 'ownership_frozen_at', type: Date, nullable: true })
  ownershipFrozenAt?: Date | null

  /**
   * Set by the guarded Connect cutover transaction once the capability
   * handshake succeeded. NULL on a `connect_managed` channel means "provisioned
   * but no traffic admitted yet": inbound claim and outbound send are rejected,
   * so no message can be observed by a projection owner that is not yet ready.
   * Always NULL for `legacy_customers` channels, whose traffic gating stays
   * `is_active` + `status` exactly as before.
   */
  @Property({ name: 'traffic_enabled_at', type: Date, nullable: true })
  trafficEnabledAt?: Date | null

  /**
   * Audit snapshot of the Connect capability handshake that authorized the
   * cutover (contract versions plus which capabilities answered). Diagnostic
   * only — authorization never reads it back.
   */
  @Property({ name: 'connect_capability_snapshot', type: 'json', nullable: true })
  connectCapabilitySnapshot?: Record<string, unknown> | null

  /**
   * How the Contract E migration classified a pre-existing tenant-wide channel
   * (`user_id IS NULL AND organization_id IS NULL`). The migration never
   * silently assigns such a channel to an organization:
   *
   * - `tenant_push_infrastructure` — FCM/APNs/Expo credentials that are genuine
   *   tenant infrastructure. They stay legacy and non-Connect forever.
   * - `email_requires_reprovision` — an email-capable channel that could have
   *   become a team inbox. It is NOT eligible for Connect until an administrator
   *   reprovisions it inside an organization; the admin page shows it as a
   *   disabled legacy channel rather than a newly owned one.
   *
   * NULL for personal mailboxes and for every channel created after the
   * migration.
   */
  @Property({ name: 'legacy_shared_classification', type: 'text', nullable: true })
  legacySharedClassification?: LegacySharedChannelClassification | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// ── SharedChannelMembership ───────────────────────────────────

/**
 * Explicit per-user membership of an organization-owned shared inbox
 * (Connect upstream Contract E).
 *
 * Membership is one of the three conjuncts of shared-inbox authorization
 * (scope + membership + ACL feature); it grants nothing on its own. Rows are
 * never hard-deleted — a revoke flips `isActive` and stamps
 * `revokedAt`/`revokedByUserId` so a mistaken revocation stays visible in the
 * recovery/audit view.
 *
 * Cross-module references (`userId → auth.user.id`) are plain uuid columns per
 * the no-cross-module-ORM-relationship rule.
 */
@Entity({ tableName: 'communication_channel_shared_members' })
// One row per (tenant, organization, channel, user) — a revoked member is
// reactivated in place rather than duplicated, so the audit trail is linear.
@Unique({
  name: 'communication_channel_shared_members_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'userId'],
})
// Authorization reads by (channel, user) and the member list reads by channel.
@Index({
  name: 'communication_channel_shared_members_channel_user_idx',
  properties: ['channelId', 'userId', 'isActive'],
})
@Index({
  name: 'communication_channel_shared_members_user_idx',
  properties: ['tenantId', 'organizationId', 'userId', 'isActive'],
})
export class SharedChannelMembership {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'isActive'
    | 'grantedByUserId'
    | 'revokedByUserId'
    | 'revokedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** NOT NULL by construction — a shared inbox always has an owning organization. */
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Logical link to communication_channels.id (intra-module, kept as plain uuid). */
  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'granted_by_user_id', type: 'uuid', nullable: true })
  grantedByUserId?: string | null

  @Property({ name: 'revoked_by_user_id', type: 'uuid', nullable: true })
  revokedByUserId?: string | null

  @Property({ name: 'revoked_at', type: Date, nullable: true })
  revokedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── ChannelDeliveryAttempt ────────────────────────────────────

/**
 * Terminal state of one outbound delivery attempt.
 *
 * `unknown` is not a failure — it means the send may have crossed the provider
 * boundary and no evidence resolves it. It is reconciliation-only and must
 * never be retried automatically; see `lib/delivery-status.ts`.
 */
export type ChannelDeliveryAttemptStatus = 'pending' | 'sent' | 'failed' | 'unknown'

/**
 * Durable correlation and outcome record for one outbound send (Connect
 * upstream Contract A).
 *
 * Email providers expose no idempotent-send key and no reliable "did message X
 * send?" query, so the hub's own record is the only thing that can answer
 * "did my send happen?" after a caller loses the response. The row is the
 * caller's handle on that question:
 *
 *   - `(tenant, organization, channel, correlationId)` is unique. The FIRST
 *     accepted submission binds that correlation to an `attemptId` and a
 *     content `fingerprint`, and the binding is immutable.
 *   - A resubmission with the SAME attempt and fingerprint returns the original
 *     outcome — it never re-enqueues.
 *   - A resubmission with a different attempt or fingerprint is a deterministic
 *     conflict. It never overwrites the binding, because doing so would let a
 *     caller silently re-point a correlation at different content.
 *   - `deliveryRevision` is monotonic per attempt and fences the terminal
 *     `sent`/`failed` decision against a late or duplicated outcome.
 */
@Entity({ tableName: 'channel_delivery_attempts' })
// Uniqueness is expressed as a partial expression index in the migration so it
// also covers rows whose organization is NULL (personal channels), which a
// plain unique constraint would not deduplicate.
@Index({
  name: 'channel_delivery_attempts_correlation_uq',
  expression:
    `create unique index "channel_delivery_attempts_correlation_uq" on "channel_delivery_attempts" ("tenant_id", (coalesce("organization_id", '00000000-0000-0000-0000-000000000000'::uuid)), "channel_id", "correlation_id")`,
})
@Index({
  name: 'channel_delivery_attempts_attempt_idx',
  properties: ['tenantId', 'channelId', 'attemptId'],
})
@Index({
  name: 'channel_delivery_attempts_message_idx',
  properties: ['messageId'],
})
@Check({
  name: 'channel_delivery_attempts_status_chk',
  expression: `"status" in ('pending', 'sent', 'failed', 'unknown')`,
})
export class ChannelDeliveryAttempt {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'deliveryRevision'
    | 'organizationId'
    | 'providerMessageId'
    | 'reasonCode'
    | 'messageId'
    | 'threadId'
    | 'actorUserId'
    | 'occurredAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Caller-stable id for "this logical send". Unique within the scope above. */
  @Property({ name: 'correlation_id', type: 'text' })
  correlationId!: string

  /** Immutable attempt identity bound to the correlation on first acceptance. */
  @Property({ name: 'attempt_id', type: 'text' })
  attemptId!: string

  /**
   * Canonical hash of recipients, subject, body and thread. A resubmission
   * whose fingerprint differs is a conflict, so a correlation can never be
   * quietly re-pointed at different content.
   */
  @Property({ name: 'fingerprint', type: 'text' })
  fingerprint!: string

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ChannelDeliveryAttemptStatus = 'pending'

  /** Monotonic per attempt; fences terminal decisions against late outcomes. */
  @Property({ name: 'delivery_revision', type: 'int', default: 0 })
  deliveryRevision: number = 0

  @Property({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId?: string | null

  @Property({ name: 'reason_code', type: 'text', nullable: true })
  reasonCode?: string | null

  /** Logical link to messages.message.id (no DB FK — cross-module). */
  @Property({ name: 'message_id', type: 'uuid', nullable: true })
  messageId?: string | null

  /** Logical link to messages.message.thread_id (no DB FK — cross-module). */
  @Property({ name: 'thread_id', type: 'uuid', nullable: true })
  threadId?: string | null

  /**
   * The authenticated actor whose authority this send was accepted under.
   *
   * Persisted so the delivery worker can RE-CHECK that authority immediately
   * before invoking the provider: a shared-inbox membership revoked between
   * enqueue and dispatch must produce a definitive
   * `failed:authorization_revoked` outcome rather than a send the revoked user
   * was no longer entitled to make. Logical link to auth.user.id.
   */
  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  /** When the recorded outcome occurred at the provider boundary. */
  @Property({ name: 'occurred_at', type: Date, nullable: true })
  occurredAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── SharedInboxOAuthState ─────────────────────────────────────

/**
 * Server-side record of an in-flight shared-mailbox OAuth authorization
 * (Connect upstream Contract E, AUTH-UP-GMAIL-01).
 *
 * The personal-mailbox OAuth flow keeps its whole state in an encrypted cookie,
 * which is enough when the flow can only ever bind a channel to the browser's
 * own user. A SHARED mailbox binds a credential to an ORGANIZATION, so the flow
 * additionally needs properties a cookie cannot provide:
 *
 *   - **One-time use.** Consumption is a single conditional UPDATE, so a
 *     replayed or duplicated callback provably cannot provision twice.
 *   - **Server-derived scope.** The tenant, organization and initiating
 *     administrator are read back from the server at callback time rather than
 *     trusted from the round-tripped cookie.
 *
 * Only `stateHash` is stored — never the raw `state` parameter — so a database
 * read cannot be replayed as a valid callback. PKCE verifiers and other
 * provider extras stay in the encrypted cookie and never land here.
 */
@Entity({ tableName: 'communication_channel_shared_oauth_states' })
@Unique({
  name: 'communication_channel_shared_oauth_states_hash_uq',
  properties: ['stateHash'],
})
@Index({
  name: 'communication_channel_shared_oauth_states_expiry_idx',
  properties: ['expiresAt'],
})
export class SharedInboxOAuthState {
  [OptionalProps]?: 'createdAt' | 'consumedAt' | 'returnUrl' | 'displayName'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** SHA-256 of the OAuth `state` parameter, hex-encoded. */
  @Property({ name: 'state_hash', type: 'text' })
  stateHash!: string

  @Property({ name: 'nonce', type: 'text' })
  nonce!: string

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'initiated_by_user_id', type: 'uuid' })
  initiatedByUserId!: string

  @Property({ name: 'provider_key', type: 'text' })
  providerKey!: string

  /** Operator-chosen inbox name, applied when the channel is created. */
  @Property({ name: 'display_name', type: 'text', nullable: true })
  displayName?: string | null

  @Property({ name: 'return_url', type: 'text', nullable: true })
  returnUrl?: string | null

  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  /** Set by the single conditional UPDATE that claims this state. */
  @Property({ name: 'consumed_at', type: Date, nullable: true })
  consumedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── ExternalConversation ──────────────────────────────────────

@Entity({ tableName: 'external_conversations' })
@Index({ name: 'external_conversations_channel_idx', properties: ['channelId', 'externalConversationId'] })
@Index({ name: 'external_conversations_contact_person_idx', properties: ['contactPersonId'] })
@Index({ name: 'external_conversations_assigned_user_idx', properties: ['assignedUserId'] })
@Unique({ name: 'external_conversations_channel_external_uq', properties: ['channelId', 'externalConversationId'] })
export class ExternalConversation {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'lastMessageAt' | 'subject' | 'contactPersonId' | 'assignedUserId' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'external_conversation_id', type: 'text' })
  externalConversationId!: string

  @Property({ name: 'subject', type: 'text', nullable: true })
  subject?: string | null

  @Property({ name: 'contact_person_id', type: 'uuid', nullable: true })
  contactPersonId?: string | null

  @Property({ name: 'assigned_user_id', type: 'uuid', nullable: true })
  assignedUserId?: string | null

  @Property({ name: 'last_message_at', type: Date, nullable: true })
  lastMessageAt?: Date | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── ExternalMessage ───────────────────────────────────────────

@Entity({ tableName: 'external_messages' })
@Index({ name: 'external_messages_conversation_idx', properties: ['conversationId'] })
@Index({ name: 'external_messages_channel_external_idx', properties: ['channelId', 'externalMessageId'] })
@Unique({ name: 'external_messages_channel_external_uq', properties: ['channelId', 'externalMessageId'] })
export class ExternalMessage {
  [OptionalProps]?: 'createdAt' | 'senderIdentifier' | 'senderDisplayName' | 'providerTimestamp' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string

  @Property({ name: 'external_message_id', type: 'text' })
  externalMessageId!: string

  @Property({ name: 'direction', type: 'text' })
  direction!: 'inbound' | 'outbound'

  @Property({ name: 'sender_identifier', type: 'text', nullable: true })
  senderIdentifier?: string | null

  @Property({ name: 'sender_display_name', type: 'text', nullable: true })
  senderDisplayName?: string | null

  @Property({ name: 'provider_timestamp', type: Date, nullable: true })
  providerTimestamp?: Date | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── MessageChannelLink ────────────────────────────────────────

@Entity({ tableName: 'message_channel_links' })
@Index({ name: 'message_channel_links_message_idx', properties: ['messageId'] })
@Index({ name: 'message_channel_links_ext_conv_idx', properties: ['externalConversationId'] })
@Index({ name: 'message_channel_links_ext_msg_idx', properties: ['externalMessageId'] })
@Unique({ name: 'message_channel_links_message_uq', properties: ['messageId'] })
@Check({
  name: 'message_channel_links_projection_mode_chk',
  expression:
    `"projection_mode_at_ingest" is null or "projection_mode_at_ingest" in ('legacy_customers', 'connect_managed')`,
})
export class MessageChannelLink {
  [OptionalProps]?: 'createdAt' | 'deliveryStatus' | 'externalMessageId' | 'channelPayload' | 'channelContentType' | 'interactiveState' | 'channelMetadata' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  /** Logical link to messages.message.id (no DB FK — cross-module via EntityExtension). */
  @Property({ name: 'message_id', type: 'uuid' })
  messageId!: string

  /** FK to external_conversations.id (intra-module — DB FK acceptable but kept as plain uuid for symmetry). */
  @Property({ name: 'external_conversation_id', type: 'uuid' })
  externalConversationId!: string

  @Property({ name: 'external_message_id', type: 'uuid', nullable: true })
  externalMessageId?: string | null

  @Property({ name: 'provider_key', type: 'text' })
  providerKey!: string

  @Property({ name: 'channel_type', type: 'text' })
  channelType!: string

  @Property({ name: 'direction', type: 'text' })
  direction!: 'inbound' | 'outbound'

  @Property({ name: 'delivery_status', type: 'text' })
  deliveryStatus: string = 'pending'

  @Property({ name: 'channel_payload', type: 'json', nullable: true })
  channelPayload?: Record<string, unknown> | null

  @Property({ name: 'channel_content_type', type: 'text', nullable: true })
  channelContentType?: string | null

  @Property({ name: 'interactive_state', type: 'json', nullable: true })
  interactiveState?: Record<string, unknown> | null

  @Property({ name: 'channel_metadata', type: 'json', nullable: true })
  channelMetadata?: Record<string, unknown> | null

  /**
   * The channel's projection mode AT THE MOMENT this message was ingested
   * (Connect upstream Contract D).
   *
   * Snapshotted rather than read live, because a later reprovision, reconnect
   * or cutover must never change how an ALREADY EMITTED
   * `communication_channels.message.received` event is classified. Without the
   * snapshot, a message ingested while the channel was legacy could later be
   * handed to Connect (double projection) or vice versa (no projection at all).
   *
   * NULL on every row written before Contract D; the envelope reader treats
   * that as `legacy_customers`, which is what those channels were.
   */
  @Property({ name: 'projection_mode_at_ingest', type: 'text', nullable: true })
  projectionModeAtIngest?: ChannelProjectionMode | null

  /** Whether Connect traffic was enabled on the channel at ingest time. */
  @Property({ name: 'traffic_enabled_at_ingest', type: 'boolean', nullable: true })
  trafficEnabledAtIngest?: boolean | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── ChannelThreadMapping ──────────────────────────────────────

@Entity({ tableName: 'channel_thread_mappings' })
@Index({ name: 'channel_thread_mappings_ext_conv_idx', properties: ['externalConversationId', 'tenantId'] })
@Index({ name: 'channel_thread_mappings_thread_idx', properties: ['messageThreadId', 'tenantId'] })
@Unique({ name: 'channel_thread_mappings_ext_conv_uq', properties: ['externalConversationId', 'tenantId'] })
export class ChannelThreadMapping {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'assignedUserId' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'external_conversation_id', type: 'uuid' })
  externalConversationId!: string

  /** Logical link to messages.message.thread_id (no DB FK — cross-module). */
  @Property({ name: 'message_thread_id', type: 'uuid' })
  messageThreadId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'provider_key', type: 'text' })
  providerKey!: string

  @Property({ name: 'external_thread_ref', type: 'text' })
  externalThreadRef!: string

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'assigned_user_id', type: 'uuid', nullable: true })
  assignedUserId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── MessageReaction ───────────────────────────────────────────

@Entity({ tableName: 'message_reactions' })
@Index({ name: 'message_reactions_message_idx', properties: ['messageId'] })
@Index({ name: 'message_reactions_message_emoji_idx', properties: ['messageId', 'emoji'] })
@Index({
  name: 'message_reactions_internal_actor_uq',
  expression:
    `create unique index "message_reactions_internal_actor_uq" on "message_reactions" ("tenant_id", "message_id", "emoji", "reacted_by_user_id") where "reacted_by_user_id" is not null`,
})
@Index({
  name: 'message_reactions_external_actor_uq',
  expression:
    `create unique index "message_reactions_external_actor_uq" on "message_reactions" ("tenant_id", "message_id", "emoji", "reacted_by_external_id") where "reacted_by_external_id" is not null`,
})
@Check({
  name: 'message_reactions_exactly_one_actor_chk',
  expression: `("reacted_by_user_id" is null) <> ("reacted_by_external_id" is null)`,
})
export class MessageReaction {
  [OptionalProps]?: 'createdAt' | 'reactedByUserId' | 'reactedByExternalId' | 'reactedByDisplayName' | 'providerKey' | 'externalReactionId' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  /** Logical link to messages.message.id (no DB FK — cross-module). */
  @Property({ name: 'message_id', type: 'uuid' })
  messageId!: string

  @Property({ name: 'emoji', type: 'text' })
  emoji!: string

  /** Logical link to auth.user.id (no DB FK — cross-module). NULL for external reactions. */
  @Property({ name: 'reacted_by_user_id', type: 'uuid', nullable: true })
  reactedByUserId?: string | null

  @Property({ name: 'reacted_by_external_id', type: 'text', nullable: true })
  reactedByExternalId?: string | null

  @Property({ name: 'reacted_by_display_name', type: 'text', nullable: true })
  reactedByDisplayName?: string | null

  @Property({ name: 'provider_key', type: 'text', nullable: true })
  providerKey?: string | null

  @Property({ name: 'external_reaction_id', type: 'text', nullable: true })
  externalReactionId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── ChannelThreadToken ────────────────────────────────────────

/**
 * Per-thread HMAC-signed opaque token used by the layered thread-matcher to
 * reliably attach inbound replies to the originating Open Mercato message
 * thread, even when the recipient's mail client strips RFC 5322 headers.
 *
 * Created lazily on the first outbound message in a thread by the
 * `outbound-bridge` subscriber. The token is injected into:
 *   1. The MIME `References:` header as `<om_TOKEN@open-mercato.invalid>` —
 *      invisible to the recipient and survives most reply clients.
 *   2. A hidden HTML body span `<span style="display:none">[OM:om_TOKEN]</span>` —
 *      survives when References is stripped (e.g. some mobile clients).
 *   3. A plain-text trailer `[OM:om_TOKEN]` — survives plain-text-only replies.
 *
 * The unique constraint is `(tenantId, token)` — tenant isolation by
 * construction. HMAC verification (via `lib/thread-token.ts`) defends against
 * forged inbound messages: tokens that don't HMAC-verify never reach the DB
 * lookup.
 *
 * See `.ai/specs/implemented/2026-05-27-email-integration-inbound-reliability-and-threading.md`.
 */
@Entity({ tableName: 'channel_thread_tokens' })
// One token row per (tenant, thread): the matcher resolves every reply to the
// same thread regardless of which outbound send minted the token. The unique
// constraint also makes `getOrCreateThreadToken` race-safe (insert-on-conflict).
@Unique({ name: 'channel_thread_tokens_thread_uq', properties: ['tenantId', 'messageThreadId'] })
@Unique({ name: 'channel_thread_tokens_token_uq', properties: ['tenantId', 'token'] })
export class ChannelThreadToken {
  [OptionalProps]?: 'createdAt' | 'lastSeenAt' | 'organizationId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  /** Logical link to messages.message.thread_id (no DB FK — cross-module). */
  @Property({ name: 'message_thread_id', type: 'uuid' })
  messageThreadId!: string

  /**
   * HMAC-signed opaque token, format: `om_<22b64url>_<11b64url>` (16 random
   * bytes + 8 HMAC bytes, each base64url-encoded without padding), ~37 chars.
   */
  @Property({ name: 'token', type: 'text' })
  token!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /**
   * Updated whenever a thread-matcher token-based strategy resolves to this
   * row. Used for future GC: tokens with `last_seen_at < now() - 90 days`
   * are pruning candidates.
   */
  @Property({ name: 'last_seen_at', type: Date, nullable: true })
  lastSeenAt?: Date | null
}

// ── ChannelIngestDeadLetter ───────────────────────────────────

/**
 * Inbound messages that fail permanently during ingest land here so an
 * operator can replay them after fixing parsers / schemas. Transient
 * failures (DB blip, network timeout) DO NOT write here — those abort the
 * poll loop without advancing the cursor so the message is re-fetched on
 * the next tick.
 *
 * `raw_body` is encrypted at rest via the module's `encryption.ts`
 * `defaultEncryptionMaps` entry (MIME bodies may contain PII).
 *
 * See `.ai/specs/implemented/2026-05-27-email-integration-inbound-reliability-and-threading.md`
 * (§ 3 Data Model).
 */
@Entity({ tableName: 'channel_ingest_dead_letters' })
@Index({ name: 'channel_ingest_dead_letters_channel_idx', properties: ['channelId', 'tenantId'] })
@Index({ name: 'channel_ingest_dead_letters_created_idx', properties: ['tenantId', 'createdAt'] })
export class ChannelIngestDeadLetter {
  [OptionalProps]?:
    | 'createdAt'
    | 'organizationId'
    | 'externalMessageId'
    | 'externalUid'
    | 'rawBody'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'provider_key', type: 'text' })
  providerKey!: string

  /** External UID / sequence-number for the provider (e.g. IMAP UID, Gmail messageId). */
  @Property({ name: 'external_uid', type: 'text', nullable: true })
  externalUid?: string | null

  @Property({ name: 'external_message_id', type: 'text', nullable: true })
  externalMessageId?: string | null

  @Property({ name: 'error_class', type: 'text' })
  errorClass!: string

  @Property({ name: 'error_message', type: 'text' })
  errorMessage!: string

  /** Truncated source — first N bytes of the raw MIME / payload (encrypted at rest). */
  @Property({ name: 'raw_body', type: 'text', nullable: true })
  rawBody?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}
