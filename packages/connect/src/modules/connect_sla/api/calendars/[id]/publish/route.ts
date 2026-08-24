import { z } from 'zod'
import { businessCalendarPublishBodySchema, businessCalendarPublishSchema } from '../../../../data/validators'
import { publishResource } from '../../../publish-route'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }
export const metadata = { path: '/connect-sla/calendars/[id]/publish', POST: { requireAuth: true, requireFeatures: ['connect_sla.calendar.manage'] } }
export async function POST(req: Request, context: RouteContext) { return publishResource({ req, id: z.string().uuid().parse((await context.params).id), schema: businessCalendarPublishSchema, commandId: 'connect_sla.calendar.publish', resourceKind: 'connect_sla.business_calendar' }) }
export const openApi = { methods: { POST: { summary: 'Publish an immutable SLA calendar version', requestBody: { schema: businessCalendarPublishBodySchema }, responses: [{ status: 200, description: 'Published calendar version', schema: z.object({ id: z.string().uuid(), updatedAt: z.string() }) }], errors: [{ status: 409, description: 'Stale calendar version' }] } } }
