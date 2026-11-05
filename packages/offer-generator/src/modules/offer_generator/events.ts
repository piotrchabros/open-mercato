import { createModuleEvents } from '@open-mercato/shared/modules/events'

export const events = [
  { id: 'offer_generator.offer.created', label: 'Offer Created', entity: 'offer', category: 'crud' },
  { id: 'offer_generator.offer.updated', label: 'Offer Updated', entity: 'offer', category: 'crud' },
  { id: 'offer_generator.offer.deleted', label: 'Offer Deleted', entity: 'offer', category: 'crud' },
  {
    id: 'offer_generator.offer.viewed',
    label: 'Offer Viewed',
    entity: 'offer',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'offer_generator.generation.started',
    label: 'Offer Generation Started',
    entity: 'generation',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'offer_generator.generation.completed',
    label: 'Offer Generation Completed',
    entity: 'generation',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'offer_generator.generation.failed',
    label: 'Offer Generation Failed',
    entity: 'generation',
    category: 'lifecycle',
    clientBroadcast: true,
  },
] as const

export type OfferGenerationEventPayload = {
  offerId: string
  runId: string
  kind: 'generate' | 'refine'
  tenantId: string
  organizationId: string
}

export const eventsConfig = createModuleEvents({ moduleId: 'offer_generator', events })
export const emitOfferGeneratorEvent = eventsConfig.emit
export type OfferGeneratorEventId = (typeof events)[number]['id']

export default eventsConfig
