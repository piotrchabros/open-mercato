import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const createConnectSlaCrudOpenApi = createCrudOpenApiFactory({ defaultTag: 'Connect SLA' })
