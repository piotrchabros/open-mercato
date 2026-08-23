import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

/**
 * Connect cost accounting inputs.
 *
 * Two rules shape both entities here:
 *
 *   1. **No cross-module ORM relationships.** `user_id` and `channel_id` are
 *      plain scalar columns. Analytics never imports `staff`,
 *      `communication_channels` or `currencies` entities, and a deleted peer
 *      record degrades to a localized "record unavailable" label rather than
 *      breaking the cost row that references it.
 *   2. **Money is never a JavaScript number.** `amount_minor` is a Postgres
 *      `bigint` mapped to a canonical decimal *string* at the ORM boundary, so
 *      no code path can round it through IEEE-754 or crash `JSON.stringify` on
 *      a native `bigint`. Validation parses it with `BigInt()` for bounds only.
 *
 * Class names are `CostInput` / `CostInputRevisionSecret` rather than
 * `ConnectCostInput*` because the entity-id generator derives the published id
 * from the class name (`<module>:<snake_case_class>`), and the spec pins
 * `connect_analytics:cost_input` as a stable contract surface.
 */

export type CostInputType = 'agent' | 'channel' | 'ai'
export type CostInputSource = 'manual' | 'provider_invoice'
export type CostInputRevisionOperation = 'create' | 'update' | 'delete'

@Entity({ tableName: 'connect_cost_inputs' })
/**
 * Half-open UTC periods. Making the emptiness of `[start, start)` impossible is
 * what stops two adjacent months from both claiming the boundary instant.
 */
@Check({
  name: 'connect_cost_inputs_period_chk',
  expression: `"period_end" > "period_start"`,
})
@Check({
  name: 'connect_cost_inputs_type_chk',
  expression: `"cost_type" in ('agent', 'channel', 'ai')`,
})
@Check({
  name: 'connect_cost_inputs_source_chk',
  expression: `"source" in ('manual', 'provider_invoice')`,
})
@Check({
  name: 'connect_cost_inputs_amount_chk',
  expression: `"amount_minor" >= 0`,
})
@Check({
  name: 'connect_cost_inputs_currency_chk',
  expression: `"currency_code" ~ '^[A-Z]{3}$'`,
})
/**
 * Conditional dimensions, enforced in the database and not only in Zod: an
 * agent row carries exactly a user, a channel row exactly a channel, and an AI
 * row neither. A row with both would silently double-count in any consumer
 * that groups by either dimension.
 */
@Check({
  name: 'connect_cost_inputs_dimension_chk',
  expression: `(
    ("cost_type" = 'agent' and "user_id" is not null and "channel_id" is null)
    or ("cost_type" = 'channel' and "channel_id" is not null and "user_id" is null)
    or ("cost_type" = 'ai' and "user_id" is null and "channel_id" is null)
  )`,
})
/**
 * Provider provenance is all-or-nothing. Half an invoice identity cannot be
 * deduplicated, and a manual row carrying one would claim a provenance nobody
 * can verify.
 */
@Check({
  name: 'connect_cost_inputs_provenance_chk',
  expression: `(
    ("source" = 'manual' and "provider_invoice_ref" is null and "provider_line_ref" is null)
    or ("source" = 'provider_invoice' and "provider_invoice_ref" is not null and "provider_line_ref" is not null)
  )`,
})
/**
 * Retry safety for provider imports.
 *
 * Partial and scoped: only live provider-invoice rows participate, so an
 * operator can still delete a mis-imported line and re-import it, and manual
 * rows — which have no external identity to deduplicate on — are untouched.
 * The *line* is part of the key so one invoice may legitimately carry many
 * charges while each external line stays idempotent.
 */
@Index({
  name: 'connect_cost_inputs_provider_line_uq',
  expression:
    'create unique index "connect_cost_inputs_provider_line_uq" on "connect_cost_inputs" ("tenant_id", "organization_id", "provider_invoice_ref", "provider_line_ref") where "source" = \'provider_invoice\' and "deleted_at" is null',
})
@Index({
  name: 'connect_cost_inputs_period_idx',
  properties: ['tenantId', 'organizationId', 'periodStart', 'periodEnd'],
})
@Index({
  name: 'connect_cost_inputs_currency_type_idx',
  properties: ['tenantId', 'organizationId', 'currencyCode', 'costType', 'periodStart'],
})
@Index({
  name: 'connect_cost_inputs_user_idx',
  properties: ['tenantId', 'organizationId', 'userId'],
})
@Index({
  name: 'connect_cost_inputs_channel_idx',
  properties: ['tenantId', 'organizationId', 'channelId'],
})
export class CostInput {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'period_start', type: Date })
  periodStart!: Date

  @Property({ name: 'period_end', type: Date })
  periodEnd!: Date

  @Property({ name: 'cost_type', type: 'text' })
  costType!: CostInputType

  @Property({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null = null

  @Property({ name: 'channel_id', type: 'uuid', nullable: true })
  channelId: string | null = null

  /**
   * Mapped to `string`, not `number` and not native `bigint`: the pg driver
   * already hands back a decimal string, and keeping it that way end-to-end is
   * what makes the published money contract exact.
   */
  @Property({ name: 'amount_minor', type: 'string', columnType: 'bigint' })
  amountMinor!: string

  @Property({ name: 'currency_code', type: 'string', columnType: 'char(3)', length: 3 })
  currencyCode!: string

  @Property({ name: 'source', type: 'text' })
  source!: CostInputSource

  @Property({ name: 'provider_invoice_ref', type: 'text', nullable: true })
  providerInvoiceRef: string | null = null

  @Property({ name: 'provider_line_ref', type: 'text', nullable: true })
  providerLineRef: string | null = null

  /** Sensitive free text. Declared in `encryption.ts`; never indexed or logged. */
  @Property({ name: 'description', type: 'text', nullable: true })
  description: string | null = null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null = null

  @Property({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId: string | null = null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /** Doubles as the optimistic-lock version for update, delete and undo. */
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt: Date | null = null
}

/**
 * One row per cost mutation, written in the same transaction as the mutation.
 *
 * It exists so undo can restore a description without the ordinary audit trail
 * ever holding one: audit payloads carry `descriptionChanged` plus this row's
 * id, and the text itself stays encrypted here behind the same scoped
 * decryption path as the live column.
 */
@Entity({ tableName: 'connect_cost_input_revision_secrets' })
@Check({
  name: 'connect_cost_input_revision_secrets_operation_chk',
  expression: `"operation" in ('create', 'update', 'delete')`,
})
@Index({
  name: 'connect_cost_input_revision_secrets_scope_idx',
  properties: ['tenantId', 'organizationId', 'costInputId'],
})
export class CostInputRevisionSecret {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'cost_input_id', type: 'uuid' })
  costInputId!: string

  @Property({ name: 'operation', type: 'text' })
  operation!: CostInputRevisionOperation

  @Property({ name: 'description_before', type: 'text', nullable: true })
  descriptionBefore: string | null = null

  @Property({ name: 'description_after', type: 'text', nullable: true })
  descriptionAfter: string | null = null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}
