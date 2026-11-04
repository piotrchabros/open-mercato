import type { EntityManager } from '@mikro-orm/postgresql'
import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  buildFeatureNotificationFromType,
  buildNotificationFromType,
} from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { MetaForm, MetaLeadEvent } from '../data/entities'
import type { LeadReceivedPayload } from '../events'
import { NOTIFICATION_TYPES, notificationTypes } from '../notifications'
import { BACKEND_PATH, type MetaScope } from './constants'
import { decryptionScope } from './scope'

export type Resolver = { resolve: <T = unknown>(n: string) => T }

type NotificationTypeId = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES]

type SendInput = {
  type: NotificationTypeId
  scope: MetaScope
  variables: Record<string, string>
  groupKey: string
  sourceEntityType: string
  sourceEntityId?: string
  linkHref?: string
  recipientUserId?: string | null
}

const MANAGE_FEATURE = 'meta_lead_ads.manage'
const MISSING_VALUE = '-'
const PLATFORM_LABELS: Record<string, string> = { fb: 'Facebook', ig: 'Instagram' }

function findTypeDefinition(type: NotificationTypeId): NotificationTypeDefinition | null {
  return notificationTypes.find((definition) => definition.type === type) ?? null
}

function textOrMissing(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : MISSING_VALUE
}

async function send(ctx: Resolver, input: SendInput): Promise<void> {
  const typeDef = findTypeDefinition(input.type)
  if (!typeDef) return
  const notificationService = resolveNotificationService(ctx)
  const common = {
    titleVariables: input.variables,
    bodyVariables: input.variables,
    sourceEntityType: input.sourceEntityType,
    ...(input.sourceEntityId ? { sourceEntityId: input.sourceEntityId } : {}),
    groupKey: input.groupKey,
    ...(input.linkHref ? { linkHref: input.linkHref } : {}),
  }
  const serviceScope = { tenantId: input.scope.tenantId, organizationId: input.scope.organizationId }
  if (input.recipientUserId) {
    await notificationService.create(
      buildNotificationFromType(typeDef, { ...common, recipientUserId: input.recipientUserId }),
      serviceScope,
    )
    return
  }
  await notificationService.createForFeature(
    {
      ...buildFeatureNotificationFromType(typeDef, { ...common, requiredFeature: MANAGE_FEATURE }),
      restrictRecipientsToOrganization: true,
    },
    serviceScope,
  )
}

export async function notifyLeadReceived(ctx: Resolver, payload: LeadReceivedPayload): Promise<void> {
  const scope: MetaScope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const em = ctx.resolve<EntityManager>('em').fork()
  const where = { tenantId: scope.tenantId, organizationId: scope.organizationId }

  const [leadEvent, form, person] = await Promise.all([
    findOneWithDecryption(em, MetaLeadEvent, { ...where, id: payload.leadEventId }, undefined, decryptionScope(scope)),
    findOneWithDecryption(em, MetaForm, { ...where, id: payload.formId }, undefined, decryptionScope(scope)),
    payload.personId
      ? findOneWithDecryption(
          em,
          CustomerEntity,
          { ...where, id: payload.personId, deletedAt: null },
          undefined,
          decryptionScope(scope),
        )
      : Promise.resolve(null),
  ])

  const email = person?.primaryEmail ?? null
  const name = person?.displayName?.trim() || email?.trim() || payload.metaLeadId
  const platform = payload.platform ? PLATFORM_LABELS[payload.platform] ?? payload.platform : null
  const variables = {
    name,
    email: textOrMissing(email),
    phone: textOrMissing(person?.primaryPhone ?? null),
    form: textOrMissing(form?.name ?? null),
    campaign: textOrMissing(leadEvent?.campaignName ?? null),
    platform: textOrMissing(platform),
  }

  await send(ctx, {
    type: payload.ownerUserId ? NOTIFICATION_TYPES.leadAssigned : NOTIFICATION_TYPES.leadUnassigned,
    scope,
    variables,
    groupKey: `meta_lead:${payload.leadEventId}`,
    sourceEntityType: payload.personId ? 'customers.person' : 'meta_lead_ads.lead_event',
    sourceEntityId: payload.personId ?? payload.leadEventId,
    linkHref: payload.personId ? `/backend/customers/people/${payload.personId}` : BACKEND_PATH,
    recipientUserId: payload.ownerUserId,
  })
}

export async function notifyFetchFailed(
  ctx: Resolver,
  input: { scope: MetaScope; leadEventId: string; metaLeadId: string; attemptCount: number },
): Promise<void> {
  await send(ctx, {
    type: NOTIFICATION_TYPES.leadFetchFailed,
    scope: input.scope,
    variables: { metaLeadId: input.metaLeadId, attemptCount: String(input.attemptCount) },
    groupKey: `meta_lead_fetch_failed:${input.leadEventId}`,
    sourceEntityType: 'meta_lead_ads.lead_event',
    sourceEntityId: input.leadEventId,
  })
}

export async function notifyDeadLettered(
  ctx: Resolver,
  input: { scope: MetaScope; leadEventId: string; metaLeadId: string; errorCode: string },
): Promise<void> {
  await send(ctx, {
    type: NOTIFICATION_TYPES.leadDeadLettered,
    scope: input.scope,
    variables: { metaLeadId: input.metaLeadId, errorCode: input.errorCode },
    groupKey: `meta_lead_dead_lettered:${input.leadEventId}`,
    sourceEntityType: 'meta_lead_ads.lead_event',
    sourceEntityId: input.leadEventId,
  })
}

export async function notifyConnectionTokenInvalid(
  ctx: Resolver,
  input: { scope: MetaScope; connectionId: string; metaUserName: string | null; reason: string },
): Promise<void> {
  await send(ctx, {
    type: NOTIFICATION_TYPES.connectionTokenInvalid,
    scope: input.scope,
    variables: { name: textOrMissing(input.metaUserName), reason: input.reason },
    groupKey: `meta_connection_token_invalid:${input.connectionId}`,
    sourceEntityType: 'meta_lead_ads.connection',
    sourceEntityId: input.connectionId,
  })
}

export async function notifyPageNoLeadsAccess(
  ctx: Resolver,
  input: { scope: MetaScope; pageId: string; pageName: string | null },
): Promise<void> {
  await send(ctx, {
    type: NOTIFICATION_TYPES.pageNoLeadsAccess,
    scope: input.scope,
    variables: { pageName: textOrMissing(input.pageName) },
    groupKey: `meta_page_no_leads_access:${input.pageId}`,
    sourceEntityType: 'meta_lead_ads.page',
    sourceEntityId: input.pageId,
  })
}

export async function notifyApiVersionDeprecated(
  ctx: Resolver,
  input: { scope: MetaScope; version: string; sunsetAt: string | Date },
): Promise<void> {
  const sunsetDate = input.sunsetAt instanceof Date ? input.sunsetAt : new Date(input.sunsetAt)
  const sunsetAt = Number.isNaN(sunsetDate.getTime())
    ? String(input.sunsetAt)
    : sunsetDate.toISOString().slice(0, 10)
  await send(ctx, {
    type: NOTIFICATION_TYPES.apiVersionDeprecated,
    scope: input.scope,
    variables: { version: input.version, sunsetAt },
    groupKey: `meta_api_version_deprecated:${input.version}`,
    sourceEntityType: 'meta_lead_ads.api_version',
  })
}
