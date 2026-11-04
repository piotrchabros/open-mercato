import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'webhook_calcom.unassigned_transcript',
    module: 'webhook_calcom',
    labelKey: 'webhook_calcom.notifications.unassigned_transcript.label',
    channels: ['in_app'],
    titleKey: 'webhook_calcom.notifications.unassigned_transcript.title',
    bodyKey: 'webhook_calcom.notifications.unassigned_transcript.body',
    icon: 'inbox',
    severity: 'info',
    actions: [
      {
        id: 'view',
        labelKey: 'common.view',
        variant: 'outline',
        href: '/backend/unassigned-transcripts/{sourceEntityId}',
        icon: 'external-link',
      },
    ],
    linkHref: '/backend/unassigned-transcripts/{sourceEntityId}',
    expiresAfterHours: 168,
  },
]

export default notificationTypes
