import { z } from 'zod'
import { policyCrud, policyMetadata } from '../administration'
import { policyCreateSchema, policyListQuerySchema } from '../../data/validators'
import { createConnectSlaCrudOpenApi } from '../openapi'

export const metadata = { path: '/connect-sla/policies', GET: policyMetadata.GET, POST: policyMetadata.POST }
export const GET = policyCrud.GET
export const POST = policyCrud.POST
export const openApi = createConnectSlaCrudOpenApi({ resourceName: 'SLA policy', querySchema: policyListQuerySchema, listResponseSchema: z.object({ items: z.array(z.unknown()) }).passthrough(), create: { schema: policyCreateSchema, responseSchema: z.object({ id: z.string().uuid(), updatedAt: z.string() }), description: 'Creates a scoped SLA policy.' } })
