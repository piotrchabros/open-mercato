import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const buildWebhookCalcomCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: 'Cal.com',
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} scoped to the authenticated organization.`,
})
