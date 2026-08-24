import { z } from 'zod'
import { NextResponse } from 'next/server'
import { calendarCrud, calendarMetadata } from '../../administration'
import { businessCalendarUpdateSchema } from '../../../data/validators'
import { createConnectSlaCrudOpenApi } from '../../openapi'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }
export const metadata = { path: '/connect-sla/calendars/[id]', GET: calendarMetadata.GET, PUT: calendarMetadata.PUT, DELETE: calendarMetadata.DELETE }

async function idFrom(context: RouteContext) { return z.string().uuid().parse((await context.params).id) }
function withId(req: Request, id: string) { const url = new URL(req.url); url.searchParams.set('id', id); return new Request(url, req) }
async function bodyWithId(req: Request, id: string) { const body = await req.json(); return new Request(req.url, { method: 'PUT', headers: req.headers, body: JSON.stringify({ ...(body as Record<string, unknown>), id }) }) }

export async function GET(req: Request, context: RouteContext) { const response = await calendarCrud.GET(withId(req, await idFrom(context))); if (!response.ok) return response; const body = await response.json() as { items?: unknown[] }; const item = body.items?.[0]; return item ? NextResponse.json(item) : NextResponse.json({ error: 'Calendar not found', code: 'calendar_not_found' }, { status: 404 }) }
export async function PUT(req: Request, context: RouteContext) { return calendarCrud.PUT(await bodyWithId(req, await idFrom(context))) }
export async function DELETE(req: Request, context: RouteContext) { return calendarCrud.DELETE(withId(req, await idFrom(context))) }

export const openApi = createConnectSlaCrudOpenApi({ resourceName: 'SLA calendar', querySchema: z.object({ id: z.string().uuid() }), listResponseSchema: z.object({ items: z.array(z.unknown()) }).passthrough(), update: { schema: businessCalendarUpdateSchema.omit({ id: true }), responseSchema: z.object({ id: z.string().uuid(), updatedAt: z.string() }), description: 'Updates a calendar with optimistic locking.' }, del: { schema: z.object({}), responseSchema: z.object({ ok: z.boolean() }), description: 'Deletes an unreferenced calendar with optimistic locking.' } })
