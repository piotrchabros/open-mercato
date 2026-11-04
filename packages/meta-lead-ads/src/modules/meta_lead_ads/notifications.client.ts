'use client'

import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import { notificationTypes } from './notifications'
import { MetaLeadAdsNotificationRenderer } from './widgets/notifications/MetaLeadAdsNotificationRenderer'

export const metaLeadAdsNotificationTypes: NotificationTypeDefinition[] = notificationTypes.map((type) => ({
  ...type,
  Renderer: MetaLeadAdsNotificationRenderer,
}))

export default metaLeadAdsNotificationTypes
