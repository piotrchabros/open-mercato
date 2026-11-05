import { notFound } from 'next/navigation'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { PublicOfferView } from '../../../components/public/PublicOfferView'
import { findPublicOffer, type PublicOfferRecord } from '../../../lib/public-offer'

const MAX_SEGMENT_LENGTH = 200

const logger = createLogger('offer_generator').child({ component: 'public-page' })

type PageParams = { segment?: string }

type OfferLookup = { status: 'found'; offer: PublicOfferRecord } | { status: 'missing' } | { status: 'unavailable' }

async function lookupOffer(segment: string): Promise<OfferLookup> {
  try {
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em').fork()
    const offer = await findPublicOffer(em, segment)
    return offer ? { status: 'found', offer } : { status: 'missing' }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'unknown'
    logger.error('Public offer page lookup failed', { errorName })
    getTelemetryRuntime()?.reportError(error, {
      module: 'offer_generator',
      code: 'offer_generator.public_page_lookup_failed',
      attributes: { errorName },
    })
    return { status: 'unavailable' }
  }
}

export default async function PublicOfferPage({ params }: { params?: PageParams | Promise<PageParams> }) {
  const resolvedParams = params ? await params : undefined
  const segment = resolvedParams?.segment ?? ''
  if (segment.length < 3 || segment.length > MAX_SEGMENT_LENGTH) notFound()

  const lookup = await lookupOffer(segment)
  if (lookup.status === 'missing') notFound()
  const offer = lookup.status === 'found' ? lookup.offer : null

  return (
    <PublicOfferView
      segment={segment}
      title={offer ? offer.title : null}
      companyName={offer && offer.companyName ? offer.companyName : null}
    />
  )
}
