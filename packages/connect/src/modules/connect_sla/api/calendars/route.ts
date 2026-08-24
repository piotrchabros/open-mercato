import { z } from 'zod'
import { calendarCrud, calendarMetadata } from '../administration'
import { businessCalendarCreateSchema, businessCalendarListQuerySchema } from '../../data/validators'
import { createConnectSlaCrudOpenApi } from '../openapi'

export const metadata = { path: '/connect-sla/calendars', GET: calendarMetadata.GET, POST: calendarMetadata.POST }
export const GET = calendarCrud.GET
export const POST = calendarCrud.POST

const itemSchema = z.object({ id: z.string().uuid(), name: z.string(), isDefault: z.boolean(), currentVersion: z.number().int().nullable(), createdAt: z.string(), updatedAt: z.string() })
export const openApi = createConnectSlaCrudOpenApi({ resourceName: 'SLA calendar', querySchema: businessCalendarListQuerySchema, listResponseSchema: z.object({ items: z.array(itemSchema) }).passthrough(), create: { schema: businessCalendarCreateSchema, responseSchema: z.object({ id: z.string().uuid(), updatedAt: z.string() }), description: 'Creates a scoped SLA calendar.' } })
