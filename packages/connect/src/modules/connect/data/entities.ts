import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Mercato Connect data model — the Case aggregate and inbound ingest state.
 *
 * `communication_channels` stores transport conversations; Connect needs a
 * separate aggregate with ownership and lifecycle semantics. Two rules shape
 * every entity here:
 *
 *   1. **Every row is organization-scoped, never tenant-wide.** The vertical
 *      spike proved a nullable-organization Case is a CRUD visibility black
 *      hole: ordinary listings cannot safely expose it, and every candidate
 *      predicate loses half its isolation. The owning channel's non-null
 *      `organization_id` is copied onto every row and is an authorization
 *      predicate, not a label.
 *   2. **No cross-module ORM relationships.** Peer identifiers
 *      (`external_conversation_id`, `channel_id`, `customer_id`) are plain
 *      columns; Connect never imports peer entities or queries peer tables.
 */

// ── Case ──────────────────────────────────────────────────────

/**
 * Case lifecycle states. `closed` is terminal: a later inbound opens a
 * successor Case carrying `previousCaseId` rather than reviving it, so a
 * customer's history stays an append-only chain.
 */
export type ConnectCaseStatus =
  | 'new'
  | 'in_progress'
  | 'waiting_customer'
  | 'resolved'
  | 'closed'

export type ConnectCasePriority = 'low' | 'normal' | 'high' | 'urgent'

@Entity({ tableName: 'connect_cases' })
@Unique({ name: 'connect_cases_number_uq', properties: ['tenantId', 'organizationId', 'number'] })
// The attach rule enumerates eligible legacy candidates by
// (tenant, organization, customer) ordered by last inbound — index exactly that.
@Index({
  name: 'connect_cases_candidate_idx',
  properties: ['tenantId', 'organizationId', 'customerId', 'status', 'lastInboundAt'],
})
@Index({
  name: 'connect_cases_assignee_idx',
  properties: ['tenantId', 'organizationId', 'assigneeUserId', 'status'],
})
@Check({
  name: 'connect_cases_status_chk',
  expression: `"status" in ('new', 'in_progress', 'waiting_customer', 'resolved', 'closed')`,
})
@Check({
  name: 'connect_cases_priority_chk',
  expression: `"priority" in ('low', 'normal', 'high', 'urgent')`,
})
export class ConnectCase {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'
    | 'status'
    | 'priority'
    | 'subject'
    | 'displayLabel'
    | 'assigneeUserId'
    | 'customerKind'
    | 'customerId'
    | 'firstInboundAt'
    | 'lastInboundAt'
    | 'resolvedAt'
    | 'closedAt'
    | 'wrapUp'
    | 'previousCaseId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** Copied from the owning shared channel. NOT NULL by construction. */
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Human-facing per-organization sequence number. */
  @Property({ name: 'number', type: 'int' })
  number!: number

  /**
   * Encrypted at rest (`data/encryption.ts`). Excluded from search documents,
   * logs and analytics, and erased by retention — an email subject routinely
   * contains the customer's own words about their problem.
   */
  @Property({ name: 'subject', type: 'text', nullable: true })
  subject?: string | null

  /**
   * Source-minimized non-PII label safe for lists, search and logs, e.g. a
   * masked handle. Never derived from the subject or body.
   */
  @Property({ name: 'display_label', type: 'text', nullable: true })
  displayLabel?: string | null

  @Property({ name: 'status', type: 'text', default: 'new' })
  status: ConnectCaseStatus = 'new'

  @Property({ name: 'priority', type: 'text', default: 'normal' })
  priority: ConnectCasePriority = 'normal'

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'assignee_user_id', type: 'uuid', nullable: true })
  assigneeUserId?: string | null

  /** Logical link to customers.customer_entity (kind + id, no DB FK). */
  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: 'person' | 'company' | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** Owning shared channel. Logical link to communication_channels.id. */
  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'first_inbound_at', type: Date, nullable: true })
  firstInboundAt?: Date | null

  @Property({ name: 'last_inbound_at', type: Date, nullable: true })
  lastInboundAt?: Date | null

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  /** Encrypted at rest — an agent's wrap-up note describes the customer. */
  @Property({ name: 'wrap_up', type: 'text', nullable: true })
  wrapUp?: string | null

  /** Set on a successor Case opened after its predecessor closed. */
  @Property({ name: 'previous_case_id', type: 'uuid', nullable: true })
  previousCaseId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /** Optimistic-lock version. Returned as `updatedAt` by every Case API. */
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// ── Conversation ──────────────────────────────────────────────

/**
 * One row per hub conversation.
 *
 * `externalConversationId` is the hub-owned `ExternalConversation.id` carried by
 * `communication_channels.message.received` as `conversationId`. It is NOT the
 * provider's thread ref and NOT the command return field
 * `externalConversationId` — substituting either would bind Connect to a key the
 * event does not actually publish.
 */
@Entity({ tableName: 'connect_conversations' })
@Unique({
  name: 'connect_conversations_external_uq',
  properties: ['tenantId', 'organizationId', 'externalConversationId'],
})
@Index({ name: 'connect_conversations_case_idx', properties: ['tenantId', 'currentCaseId'] })
export class ConnectConversation {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'currentCaseId'
    | 'lastExternalMessageId'
    | 'lastMessageAt'
    | 'replyTargetRef'
    | 'replyTargetMaskedLabel'
    | 'replyTargetSourceVersion'
    | 'replyTargetMessageId'
    | 'replyTargetExternalMessageId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** `communication_channels.external_conversations.id`. */
  @Property({ name: 'external_conversation_id', type: 'uuid' })
  externalConversationId!: string

  @Property({ name: 'current_case_id', type: 'uuid', nullable: true })
  currentCaseId?: string | null

  @Property({ name: 'last_external_message_id', type: 'uuid', nullable: true })
  lastExternalMessageId?: string | null

  @Property({ name: 'last_message_at', type: Date, nullable: true })
  lastMessageAt?: Date | null

  /**
   * Latest source-issued opaque reply-target reference (Contract D) plus its
   * masked label and provenance. Only a NEWER accepted inbound for this
   * conversation may replace it, so a late-arriving older message cannot
   * re-point replies at a stale address.
   *
   * The reference carries no address; resolution happens at send time.
   */
  @Property({ name: 'reply_target_ref', type: 'text', nullable: true })
  replyTargetRef?: string | null

  @Property({ name: 'reply_target_masked_label', type: 'text', nullable: true })
  replyTargetMaskedLabel?: string | null

  @Property({ name: 'reply_target_source_version', type: 'int', nullable: true })
  replyTargetSourceVersion?: number | null

  /** Exact provenance of the reference: which message issued it. */
  @Property({ name: 'reply_target_message_id', type: 'uuid', nullable: true })
  replyTargetMessageId?: string | null

  @Property({ name: 'reply_target_external_message_id', type: 'uuid', nullable: true })
  replyTargetExternalMessageId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Append-only conversation-to-Case intervals.
 *
 * A conversation can move between Cases (a closed Case's successor, an agent
 * transfer). Overwriting `currentCaseId` alone would lose which Case a given
 * message belonged to at the time, so the interval history is kept beside it.
 */
@Entity({ tableName: 'connect_conversation_case_bindings' })
@Index({
  name: 'connect_conversation_case_bindings_conv_idx',
  properties: ['tenantId', 'conversationId', 'boundAt'],
})
@Index({
  name: 'connect_conversation_case_bindings_case_idx',
  properties: ['tenantId', 'caseId'],
})
export class ConnectConversationCaseBinding {
  [OptionalProps]?: 'createdAt' | 'unboundAt' | 'reason'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'bound_at', type: Date })
  boundAt!: Date

  @Property({ name: 'unbound_at', type: Date, nullable: true })
  unboundAt?: Date | null

  @Property({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── Contact identity ──────────────────────────────────────────

export type ConnectIdentityLinkState = 'unresolved' | 'linked' | 'rejected'

/**
 * A contact handle seen on a channel, and what Connect believes it maps to.
 *
 * The handle VALUE is encrypted at rest and never appears in a search document.
 * Equality matching goes through `handleHash`, which is written even when
 * tenant data encryption is disabled — otherwise enabling encryption later
 * would silently make every existing identity invisible to lookup.
 */
@Entity({ tableName: 'connect_contact_identities' })
@Unique({
  name: 'connect_contact_identities_hash_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'handleHash'],
})
@Index({
  name: 'connect_contact_identities_customer_idx',
  properties: ['tenantId', 'organizationId', 'customerId'],
})
@Check({
  name: 'connect_contact_identities_link_state_chk',
  expression: `"link_state" in ('unresolved', 'linked', 'rejected')`,
})
export class ConnectContactIdentity {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'linkState'
    | 'customerKind'
    | 'customerId'
    | 'confidence'
    | 'matchMethod'
    | 'handleDisplayLabel'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'handle_type', type: 'text' })
  handleType!: string

  /** Encrypted at rest. Never rendered into a search document. */
  @Property({ name: 'handle_value', type: 'text' })
  handleValue!: string

  /** Deterministic blind index. Always written; the only lookup path. */
  @Property({ name: 'handle_hash', type: 'text' })
  handleHash!: string

  /** Masked, non-PII label safe for lists and logs. */
  @Property({ name: 'handle_display_label', type: 'text', nullable: true })
  handleDisplayLabel?: string | null

  @Property({ name: 'link_state', type: 'text', default: 'unresolved' })
  linkState: ConnectIdentityLinkState = 'unresolved'

  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: 'person' | 'company' | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** 0–100 match confidence. */
  @Property({ name: 'confidence', type: 'int', nullable: true })
  confidence?: number | null

  @Property({ name: 'match_method', type: 'text', nullable: true })
  matchMethod?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * The identity's current Case, and the row every writer serializes on.
 *
 * Ingest, link, unlink and resolve all lock this row before deciding anything,
 * so two inbound messages from the same person cannot both conclude "no active
 * Case" and open two.
 */
@Entity({ tableName: 'connect_identity_case_bindings' })
@Unique({
  name: 'connect_identity_case_bindings_identity_uq',
  properties: ['tenantId', 'organizationId', 'identityId'],
})
export class ConnectIdentityCaseBinding {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'currentCaseId' | 'version'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'current_case_id', type: 'uuid', nullable: true })
  currentCaseId?: string | null

  /** Monotonic provenance counter, bumped on every rebinding. */
  @Property({ name: 'version', type: 'int', default: 0 })
  version: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Case transitions ──────────────────────────────────────────

/** Append-only lifecycle audit. Written in the same transaction as the Case. */
@Entity({ tableName: 'connect_case_transitions' })
@Index({ name: 'connect_case_transitions_case_idx', properties: ['tenantId', 'caseId', 'createdAt'] })
export class ConnectCaseTransition {
  [OptionalProps]?: 'createdAt' | 'payload' | 'actorUserId' | 'fromStatus'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  /** `system` for ingest-driven transitions, `user` for agent commands. */
  @Property({ name: 'actor_kind', type: 'text' })
  actorKind!: 'system' | 'user'

  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'from_status', type: 'text', nullable: true })
  fromStatus?: ConnectCaseStatus | null

  @Property({ name: 'to_status', type: 'text' })
  toStatus!: ConnectCaseStatus

  /** Non-PII context only — never the message subject or body. */
  @Property({ name: 'payload', type: 'json', nullable: true })
  payload?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── Inbound receipt ───────────────────────────────────────────

export type ConnectReceiptStatus = 'processing' | 'completed'
export type ConnectReceiptDisposition = 'opened' | 'attached' | 'suppressed' | 'dead_lettered'

/**
 * The idempotency record for one inbound event.
 *
 * Claimed by a UNIQUE INSERT before any non-idempotent work — no
 * read-then-create arbitration, because two deliveries racing that check would
 * both pass it. A duplicate delivery loses the insert, catches the unique
 * violation, looks up the winner and returns success.
 */
@Entity({ tableName: 'connect_inbound_receipts' })
@Unique({
  name: 'connect_inbound_receipts_message_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'externalMessageId'],
})
@Index({
  name: 'connect_inbound_receipts_sweep_idx',
  properties: ['tenantId', 'status', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_inbound_receipts_status_chk',
  expression: `"status" in ('processing', 'completed')`,
})
@Check({
  name: 'connect_inbound_receipts_disposition_chk',
  expression: `"disposition" is null or "disposition" in ('opened', 'attached', 'suppressed', 'dead_lettered')`,
})
// The state machine, expressed where it cannot be bypassed: a processing
// receipt has no disposition and no Case; a completed open/attach MUST name its
// Case; a suppressed or dead-lettered receipt must NOT, because nothing was
// created for it.
@Check({
  name: 'connect_inbound_receipts_shape_chk',
  expression:
    `("status" = 'processing' and "disposition" is null and "case_id" is null)
     or ("status" = 'completed' and "disposition" in ('opened', 'attached') and "case_id" is not null)
     or ("status" = 'completed' and "disposition" in ('suppressed', 'dead_lettered') and "case_id" is null)`,
})
export class ConnectInboundReceipt {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'disposition'
    | 'terminalReason'
    | 'caseId'
    | 'leaseExpiresAt'
    | 'attempts'
    | 'lastAttemptAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** `communication_channels.external_messages.id` from the event. */
  @Property({ name: 'external_message_id', type: 'uuid' })
  externalMessageId!: string

  /** Stable source event id, for tracing a receipt back to its delivery. */
  @Property({ name: 'source_event_id', type: 'text', nullable: true })
  sourceEventId?: string | null

  /**
   * UTC date the receipt was first claimed. Immutable, and the partition key
   * every operational metric counts by — deriving a cohort from `created_at`
   * later would shift historical numbers when a receipt is retried.
   */
  @Property({ name: 'claim_cohort_utc_date', type: 'date' })
  claimCohortUtcDate!: string

  @Property({ name: 'status', type: 'text', default: 'processing' })
  status: ConnectReceiptStatus = 'processing'

  @Property({ name: 'disposition', type: 'text', nullable: true })
  disposition?: ConnectReceiptDisposition | null

  @Property({ name: 'terminal_reason', type: 'text', nullable: true })
  terminalReason?: string | null

  @Property({ name: 'case_id', type: 'uuid', nullable: true })
  caseId?: string | null

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'last_attempt_at', type: Date, nullable: true })
  lastAttemptAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Suppression counter ───────────────────────────────────────

/**
 * Auto-responder / loop suppression, keyed by
 * `(tenant, organization, channel, from_handle_hash)`.
 *
 * Deliberately NOT keyed more broadly: a tenant- or organization-wide bucket
 * means one looping sender suppresses unrelated customers' mail, which is a
 * worse failure than the loop it prevents.
 */
@Entity({ tableName: 'connect_inbound_suppressions' })
@Unique({
  name: 'connect_inbound_suppressions_key_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'fromHandleHash', 'windowStartedAt'],
})
@Index({
  name: 'connect_inbound_suppressions_window_idx',
  properties: ['tenantId', 'windowStartedAt'],
})
export class ConnectInboundSuppression {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'hitCount' | 'lastExternalMessageId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Blind index of the sender handle — never the handle itself. */
  @Property({ name: 'from_handle_hash', type: 'text' })
  fromHandleHash!: string

  @Property({ name: 'window_started_at', type: Date })
  windowStartedAt!: Date

  @Property({ name: 'hit_count', type: 'int', default: 0 })
  hitCount: number = 0

  /** Makes each increment idempotent by external message id. */
  @Property({ name: 'last_external_message_id', type: 'uuid', nullable: true })
  lastExternalMessageId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Settings ──────────────────────────────────────────────────

/** Per-organization ingestion settings. One row per organization. */
@Entity({ tableName: 'connect_settings' })
@Unique({ name: 'connect_settings_scope_uq', properties: ['tenantId', 'organizationId'] })
@Check({
  name: 'connect_settings_windows_chk',
  expression: `"reopen_window_days" <= "auto_close_after_days"`,
})
export class ConnectSettings {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'attachWindowHours'
    | 'reopenWindowDays'
    | 'autoCloseAfterDays'
    | 'identityMatchThreshold'
    | 'suppressionCount'
    | 'suppressionWindowMinutes'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** How long an open Case keeps absorbing new inbound from the same identity. */
  @Property({ name: 'attach_window_hours', type: 'int', default: 72 })
  attachWindowHours: number = 72

  /** How long a resolved Case may be reopened instead of superseded. */
  @Property({ name: 'reopen_window_days', type: 'int', default: 7 })
  reopenWindowDays: number = 7

  /** How long a resolved Case waits before closing. Must be >= reopen window. */
  @Property({ name: 'auto_close_after_days', type: 'int', default: 14 })
  autoCloseAfterDays: number = 14

  /** 0–100. Below it, an identity stays unresolved rather than guessing. */
  @Property({ name: 'identity_match_threshold', type: 'int', default: 80 })
  identityMatchThreshold: number = 80

  @Property({ name: 'suppression_count', type: 'int', default: 3 })
  suppressionCount: number = 3

  @Property({ name: 'suppression_window_minutes', type: 'int', default: 60 })
  suppressionWindowMinutes: number = 60

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Domain outbox ─────────────────────────────────────────────

export type ConnectOutboxStatus = 'pending' | 'published'

/**
 * Transactional outbox for Connect domain events.
 *
 * Inserted in the SAME transaction as the domain mutation, so an event can
 * never describe a state that was rolled back, and a crash between commit and
 * publish loses nothing — the sweeper drains what the wake job missed.
 */
@Entity({ tableName: 'connect_domain_outbox' })
@Unique({ name: 'connect_domain_outbox_event_uq', properties: ['tenantId', 'sourceEventId'] })
@Index({
  name: 'connect_domain_outbox_pending_idx',
  properties: ['status', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_domain_outbox_status_chk',
  expression: `"status" in ('pending', 'published')`,
})
export class ConnectDomainOutboxEntry {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'leaseExpiresAt' | 'publishedAt' | 'attempts'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Stable, caller-derived id. Makes publication idempotent across retries. */
  @Property({ name: 'source_event_id', type: 'text' })
  sourceEventId!: string

  @Property({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string

  @Property({ name: 'aggregate_version', type: 'int' })
  aggregateVersion!: number

  @Property({ name: 'event_type', type: 'text' })
  eventType!: string

  /** Identifier-only. Never message content. */
  @Property({ name: 'payload', type: 'json' })
  payload!: Record<string, unknown>

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ConnectOutboxStatus = 'pending'

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'published_at', type: Date, nullable: true })
  publishedAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
