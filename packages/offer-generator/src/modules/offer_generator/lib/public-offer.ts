import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Offer } from '../data/entities'
import type { OfferLanguage, OfferStatus } from '../data/validators'
import { getOfferGeneratorSettings } from './settings'
import { parseOfferSegment, timingSafeEqualStrings } from './slug'

export type PublicOfferRoute = {
  id: string
  tenantId: string
  organizationId: string
  status: OfferStatus
}

export type PublicOfferRecord = PublicOfferRoute & {
  title: string
  clientName: string
  html: string
  language: OfferLanguage
  companyName: string
}

export async function resolvePublicOfferRoute(
  em: EntityManager,
  segment: string,
): Promise<PublicOfferRoute | null> {
  const parsed = parseOfferSegment(segment)
  if (!parsed) return null
  const routing = await em
    .fork()
    .findOne(
      Offer,
      { slug: parsed.slug, deletedAt: null, html: { $ne: null } },
      { fields: ['id', 'tenantId', 'organizationId', 'accessToken', 'status'] },
    )
  if (!routing || !routing.accessToken) return null
  if (!timingSafeEqualStrings(routing.accessToken, parsed.token)) return null
  if (routing.status === 'draft') return null
  return {
    id: routing.id,
    tenantId: routing.tenantId,
    organizationId: routing.organizationId,
    status: routing.status,
  }
}

export async function findPublicOffer(em: EntityManager, segment: string): Promise<PublicOfferRecord | null> {
  const route = await resolvePublicOfferRoute(em, segment)
  if (!route) return null
  const scope = { tenantId: route.tenantId, organizationId: route.organizationId }
  const offer = await findOneWithDecryption(
    em,
    Offer,
    { id: route.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    { fields: ['id', 'title', 'clientName', 'html', 'language', 'status'] },
    scope,
  )
  if (!offer || !offer.html || offer.status === 'draft') return null
  const settings = await getOfferGeneratorSettings(em, scope)
  return {
    ...route,
    status: offer.status,
    title: offer.title,
    clientName: offer.clientName,
    html: offer.html,
    language: offer.language,
    companyName: settings.companyName,
  }
}
