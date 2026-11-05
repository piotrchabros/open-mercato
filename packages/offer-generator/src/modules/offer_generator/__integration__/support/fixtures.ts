import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { expectId, getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { OfferCreateInput } from '../../data/validators'
import { PUBLIC_PATH_PREFIX, QUEUES } from '../../lib/constants'
import type { GenerationRunDto, OfferDto, OfferHtmlDto, RevisionDto } from '../../lib/serializers'

export const FAKE_INCOMPLETE_MARKER = '__FAKE_INCOMPLETE__'
export const STALE_UPDATED_AT = '2000-01-01T00:00:00.000Z'
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

const BASE_URL = process.env.BASE_URL?.trim() || null

export type OfferTestEnv = {
  request: APIRequestContext
  token: string
  tenantId: string
  orgId: string
  cleanup(): Promise<void>
}

export type OfferCreateBody = Omit<OfferCreateInput, 'tenantId' | 'organizationId'>

type ListResponse<Item> = { items?: Item[] }

type OrgFetchOptions = {
  data?: unknown
  headers?: Record<string, string>
}

const ORG_TABLES_IN_DELETE_ORDER = [
  'offer_generator_offer_views',
  'offer_generator_offer_revisions',
  'offer_generator_generation_runs',
  'offer_generator_offers',
  'offer_generator_settings',
] as const

export function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

export function resolveAppOrigin(): string {
  return new URL(BASE_URL ?? 'http://localhost:3000').origin
}

export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function lockHeaders(expectedUpdatedAt: string | null | undefined): Record<string, string> {
  return expectedUpdatedAt ? { [OPTIMISTIC_LOCK_HEADER_NAME]: expectedUpdatedAt } : {}
}

export function orgFetch(
  env: OfferTestEnv,
  method: string,
  path: string,
  options: OrgFetchOptions = {},
): Promise<APIResponse> {
  return orgFetchFor(env, env.orgId, method, path, options)
}

export function orgFetchFor(
  env: OfferTestEnv,
  orgId: string,
  method: string,
  path: string,
  options: OrgFetchOptions = {},
): Promise<APIResponse> {
  if (!options.headers) {
    return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: orgId, data: options.data })
  }
  return env.request.fetch(resolveUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      Cookie: `om_selected_org=${orgId}`,
      ...options.headers,
    },
    data: options.data,
  })
}

async function purgeOrganizationOffers(orgId: string): Promise<void> {
  await withClient(async (client) => {
    for (const table of ORG_TABLES_IN_DELETE_ORDER) {
      await client.query(`delete from ${table} where organization_id = $1`, [orgId])
    }
    await client.query('delete from progress_jobs where organization_id = $1', [orgId])
  }).catch(() => undefined)
}

export async function createExtraOrganization(env: OfferTestEnv, label: string): Promise<string> {
  return createOrganizationFixture(env.request, env.token, { name: `Offer Generator ${label} ${uniqueSuffix()}` })
}

export async function deleteExtraOrganization(env: OfferTestEnv, orgId: string | null): Promise<void> {
  if (!orgId) return
  await purgeOrganizationOffers(orgId)
  await deleteOrganizationIfExists(env.request, env.token, orgId)
}

export async function setupOfferTestEnv(request: APIRequestContext): Promise<OfferTestEnv> {
  const token = await getAuthToken(request, 'superadmin')
  const { tenantId } = getTokenContext(token)
  const orgId = await createOrganizationFixture(request, token, { name: `Offer Generator ${uniqueSuffix()}` })
  const env: OfferTestEnv = {
    request,
    token,
    tenantId,
    orgId,
    cleanup: async () => {
      await purgeOrganizationOffers(orgId)
      await deleteOrganizationIfExists(request, token, orgId)
    },
  }
  return env
}

export function buildOfferHtml(marker: string, extraBody = ''): string {
  const paragraph =
    'This offer describes the full scope of the engagement, the delivery schedule, the pricing of every package and the terms of cooperation agreed with the client during the discovery call.'
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Offer</title><style>body{font-family:sans-serif}</style></head>',
    '<body>',
    `<section data-section="intro"><h1 data-marker="${marker}">Offer ${marker}</h1><p>${paragraph}</p></section>`,
    `<section data-section="pricing"><h2>Pricing</h2><p>${paragraph}</p></section>`,
    extraBody,
    '</body>',
    '</html>',
  ].join('')
}

export function segmentFromPublicUrl(publicUrl: string): string {
  const marker = `${PUBLIC_PATH_PREFIX}/`
  const index = publicUrl.lastIndexOf(marker)
  expect(index, 'publicUrl should contain the public path prefix').toBeGreaterThanOrEqual(0)
  return publicUrl.slice(index + marker.length)
}

export async function createOfferFixture(env: OfferTestEnv, input: Partial<OfferCreateBody> = {}): Promise<string> {
  const response = await orgFetch(env, 'POST', '/api/offer_generator/offers', {
    data: {
      title: `QA offer ${uniqueSuffix()}`,
      clientName: 'QA Client Sp z o o',
      language: 'en',
      ...input,
    },
  })
  const body = await readJsonSafe<{ id?: string }>(response)
  expect(response.status(), 'POST /api/offer_generator/offers should return 201').toBe(201)
  return expectId(body?.id, 'Offer creation response should include id')
}

export async function findOffer(env: OfferTestEnv, offerId: string, orgId: string = env.orgId): Promise<OfferDto | null> {
  const response = await orgFetchFor(env, orgId, 'GET', `/api/offer_generator/offers?id=${encodeURIComponent(offerId)}`)
  expect(response.status(), 'GET /api/offer_generator/offers?id= should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<OfferDto>>(response)
  return body?.items?.find((item) => item.id === offerId) ?? null
}

export async function readOffer(env: OfferTestEnv, offerId: string): Promise<OfferDto> {
  const offer = await findOffer(env, offerId)
  expect(offer, `Offer ${offerId} should be readable`).toBeTruthy()
  return offer as OfferDto
}

export async function updateOffer(
  env: OfferTestEnv,
  offerId: string,
  patch: Record<string, unknown>,
  expectedUpdatedAt?: string | null,
): Promise<APIResponse> {
  return orgFetch(env, 'PUT', '/api/offer_generator/offers', {
    data: { id: offerId, ...patch },
    headers: lockHeaders(expectedUpdatedAt),
  })
}

export async function deleteOfferIfExists(env: OfferTestEnv, offerId: string | null): Promise<void> {
  if (!offerId) return
  await orgFetch(env, 'DELETE', `/api/offer_generator/offers?id=${encodeURIComponent(offerId)}`).catch(() => undefined)
}

export async function readOfferHtml(env: OfferTestEnv, offerId: string): Promise<OfferHtmlDto> {
  const response = await orgFetch(env, 'GET', `/api/offer_generator/offers/${offerId}/html`)
  expect(response.status(), 'GET offer html should return 200').toBe(200)
  const body = await readJsonSafe<OfferHtmlDto>(response)
  expect(body, 'GET offer html should return a body').toBeTruthy()
  return body as OfferHtmlDto
}

export async function putOfferHtml(
  env: OfferTestEnv,
  offerId: string,
  html: string,
  expectedUpdatedAt?: string | null,
): Promise<APIResponse> {
  return orgFetch(env, 'PUT', `/api/offer_generator/offers/${offerId}/html`, {
    data: { html },
    headers: lockHeaders(expectedUpdatedAt),
  })
}

export async function setOfferHtml(env: OfferTestEnv, offerId: string, html: string): Promise<void> {
  const response = await putOfferHtml(env, offerId, html)
  expect(response.status(), 'PUT offer html should return 200').toBe(200)
}

export async function listRevisions(env: OfferTestEnv, offerId: string): Promise<RevisionDto[]> {
  const response = await orgFetch(env, 'GET', `/api/offer_generator/offers/${offerId}/revisions`)
  expect(response.status(), 'GET offer revisions should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<RevisionDto>>(response)
  return body?.items ?? []
}

export async function createPublishedOffer(env: OfferTestEnv, marker: string): Promise<OfferDto> {
  const offerId = await createOfferFixture(env)
  await setOfferHtml(env, offerId, buildOfferHtml(marker))
  const response = await updateOffer(env, offerId, { status: 'sent' })
  expect(response.status(), 'PUT offer status sent should return 200').toBe(200)
  return readOffer(env, offerId)
}

export async function readGenerationRun(env: OfferTestEnv, runId: string): Promise<GenerationRunDto> {
  const response = await orgFetch(env, 'GET', `/api/offer_generator/generation-runs/${runId}`)
  expect(response.status(), 'GET generation run should return 200').toBe(200)
  const body = await readJsonSafe<GenerationRunDto>(response)
  expect(body, 'GET generation run should return a body').toBeTruthy()
  return body as GenerationRunDto
}

export async function waitForGenerationRun(env: OfferTestEnv, runId: string): Promise<GenerationRunDto> {
  await expect
    .poll(
      async () => {
        await drainIntegrationQueue(QUEUES.generate)
        return (await readGenerationRun(env, runId)).status
      },
      { message: `Generation run ${runId} should finish`, timeout: 60_000 },
    )
    .toMatch(/^(completed|failed)$/)
  return readGenerationRun(env, runId)
}

export async function readProgressJobStatus(env: OfferTestEnv, jobId: string): Promise<string | null> {
  const response = await orgFetch(env, 'GET', `/api/progress/jobs/${jobId}`)
  expect(response.status(), 'GET progress job should return 200').toBe(200)
  const body = await readJsonSafe<{ status?: string }>(response)
  return body?.status ?? null
}
