import { z } from 'zod'
import { policyPublishBodySchema, policyPublishSchema } from '../../../../data/validators'
import { publishResource } from '../../../publish-route'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }
export const metadata = { path: '/connect-sla/policies/[id]/publish', POST: { requireAuth: true, requireFeatures: ['connect_sla.policy.manage'] } }
export async function POST(req: Request, context: RouteContext) { return publishResource({ req, id: z.string().uuid().parse((await context.params).id), schema: policyPublishSchema, commandId: 'connect_sla.policy.publish', resourceKind: 'connect_sla.policy' }) }
export const openApi = { methods: { POST: { summary: 'Publish an immutable SLA policy version', requestBody: { schema: policyPublishBodySchema }, responses: [{ status: 200, description: 'Published policy version', schema: z.object({ id: z.string().uuid(), updatedAt: z.string() }) }], errors: [{ status: 409, description: 'Stale policy version' }] } } }
