import { z } from 'zod'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { CALCOM_INTEGRATION_ID } from '../integration'

export const calcomCredentialsSchema = z.object({
  webhookSecret: z.string().trim().min(1),
  instanceUrl: z.string().trim().url(),
  unmatchedAttendeePolicy: z.enum(['create_person', 'skip']).catch('create_person').default('create_person'),
})

export type CalcomCredentials = z.infer<typeof calcomCredentialsSchema>

export type CalcomCredentialsService = {
  resolve(integrationId: string, scope: IntegrationScope): Promise<Record<string, unknown> | null>
}

export async function resolveCalcomCredentials(
  credentialsService: CalcomCredentialsService,
  scope: IntegrationScope,
): Promise<CalcomCredentials | null> {
  const raw = await credentialsService.resolve(CALCOM_INTEGRATION_ID, scope)
  if (!raw) return null
  const parsed = calcomCredentialsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
