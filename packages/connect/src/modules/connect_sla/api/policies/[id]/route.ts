import { z } from 'zod'
import { NextResponse } from 'next/server'
import { policyCrud, policyMetadata } from '../../administration'
import { policyUpdateSchema } from '../../../data/validators'
import { createConnectSlaCrudOpenApi } from '../../openapi'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }
export const metadata = { path: '/connect-sla/policies/[id]', GET: policyMetadata.GET, PUT: policyMetadata.PUT, DELETE: policyMetadata.DELETE }
async function idFrom(context: RouteContext) { return z.string().uuid().parse((await context.params).id) }
function withId(req: Request, id: string) { const url = new URL(req.url); url.searchParams.set('id', id); return new Request(url, req) }
async function bodyWithId(req: Request, id: string) { const body = await req.json(); return new Request(req.url, { method: 'PUT', headers: req.headers, body: JSON.stringify({ ...(body as Record<string, unknown>), id }) }) }
export async function GET(req: Request, context: RouteContext) { const response = await policyCrud.GET(withId(req, await idFrom(context))); if (!response.ok) return response; const body = await response.json() as { items?: unknown[] }; const item = body.items?.[0]; return item ? NextResponse.json(item) : NextResponse.json({ error: 'Policy not found', code: 'policy_not_found' }, { status: 404 }) }
export async function PUT(req: Request, context: RouteContext) { return policyCrud.PUT(await bodyWithId(req, await idFrom(context))) }
export async function DELETE(req: Request, context: RouteContext) { return policyCrud.DELETE(withId(req, await idFrom(context))) }
export const openApi = createConnectSlaCrudOpenApi({ resourceName: 'SLA policy', querySchema: z.object({ id: z.string().uuid() }), listResponseSchema: z.object({ items: z.array(z.unknown()) }).passthrough(), update: { schema: policyUpdateSchema.omit({ id: true }), responseSchema: z.object({ id: z.string().uuid(), updatedAt: z.string() }), description: 'Updates a policy with optimistic locking.' }, del: { schema: z.object({}), responseSchema: z.object({ ok: z.boolean() }), description: 'Deletes an unreferenced policy with optimistic locking.' } })
