import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildFeatureNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'
import { CalcomUnassignedTranscript } from '../data/entities'
import type { CalcomUnassignedTranscriptCreatedPayload } from '../events'
import { notificationTypes } from '../notifications'

const logger = createLogger('webhook_calcom').child({ component: 'notify-unassigned-transcript' })

export const metadata = {
  event: 'webhook_calcom.unassigned_transcript.created',
  persistent: true,
  id: 'webhook_calcom:notify-unassigned-transcript',
}

export default async function handle(payload: CalcomUnassignedTranscriptCreatedPayload) {
  try {
    const typeDef = notificationTypes.find((type) => type.type === 'webhook_calcom.unassigned_transcript')
    if (!typeDef) return

    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em').fork()
    const row = await findOneWithDecryption(
      em,
      CalcomUnassignedTranscript,
      {
        id: payload.id,
        tenantId: payload.tenantId,
        organizationId: payload.organizationId,
        deletedAt: null,
      },
      {},
      { tenantId: payload.tenantId, organizationId: payload.organizationId },
    )
    if (!row || row.status !== 'pending') return

    const notificationInput = {
      ...buildFeatureNotificationFromType(typeDef, {
        requiredFeature: 'webhook_calcom.transcripts.manage',
        bodyVariables: { title: row.title },
        sourceEntityType: 'webhook_calcom:calcom_unassigned_transcript',
        sourceEntityId: row.id,
        groupKey: `webhook_calcom:unassigned:${payload.organizationId}`,
      }),
      restrictRecipientsToOrganization: true,
    }

    await resolveNotificationService(container).createForFeature(notificationInput, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
    })
  } catch (err) {
    logger.error('Failed to create unassigned transcript notification', { err })
  }
}
