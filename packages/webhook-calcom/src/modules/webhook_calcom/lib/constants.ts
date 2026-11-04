import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'

export const CALCOM_INTERACTION_ENTITY = 'customers:customer_interaction'
export const CALCOM_ATTACHMENT_ENTITY = 'attachments:attachment'
export const CALCOM_PERSON_SOURCE = 'calcom'
export const MAX_SUMMARY_COMMENT_CHARS = 8000
export const MAX_INTERACTION_BODY_CHARS = 10000

export function calcomLockKey(scope: IntegrationScope): string {
  return `calcom:sync:${scope.tenantId}:${scope.organizationId}`
}
