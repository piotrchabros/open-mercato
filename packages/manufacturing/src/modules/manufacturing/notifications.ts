import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

/**
 * Task 5.2 — notification type for the "buy" acceptance path (spec decision
 * d: "buy = export/notification + `manufacturing.mrp_suggestion.accepted`
 * event as the purchasing seam"). Created by
 * `subscribers/mrp-suggestion-accepted-notification.ts` when a `buy`
 * suggestion is accepted, mirroring `catalog.product.low_stock`
 * (`catalog/notifications.ts` + `catalog/subscribers/low-stock-notification.ts`).
 */
export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'manufacturing.mrp.buy_suggestion_accepted',
    module: 'manufacturing',
    titleKey: 'manufacturing.notifications.mrp.buySuggestionAccepted.title',
    bodyKey: 'manufacturing.notifications.mrp.buySuggestionAccepted.body',
    icon: 'shopping-cart',
    severity: 'info',
    actions: [
      {
        id: 'export',
        labelKey: 'manufacturing.notifications.mrp.buySuggestionAccepted.exportAction',
        variant: 'outline',
        href: '/api/manufacturing/mrp/suggestions/export',
        icon: 'download',
      },
    ],
    linkHref: '/backend/manufacturing/mrp',
    expiresAfterHours: 168, // 7 days
  },
]

export default notificationTypes
