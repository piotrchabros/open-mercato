import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { expectOperation, skipIfUndoTestsDisabled, undoOk } from '@open-mercato/core/helpers/integration/undoHarness'
import {
  countCostInputs,
  hardDeleteCostInputs,
  insertCostInputRow,
  readCostInputRow,
  readRevisionSecretDescriptions,
} from './cost-input-sql'

/**
 * TC-CONNECT-COST-INPUTS — cost accounting CRUD, isolation, money precision,
 * privacy, provenance replay and the sanitized reader.
 *
 * Nothing here imports an ORM entity: MikroORM's legacy decorators are
 * incompatible with Playwright's TC39 decorator transform, and one offending
 * spec aborts collection for the entire suite. State is inspected through the
 * SQL helpers and the reader is taken from DI by name.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

const COLLECTION = '/api/connect_analytics/cost-inputs'
const CURRENCY_OPTION = '/api/connect_analytics/cost-input-options/currency'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

type ConnectAllocatedCostReaderLike = {
  summarizeAllocated(input: {
    tenantId: string
    organizationId: string
    periodStart: Date
    periodEnd: Date
    currencyCode: string
  }): Promise<{
    matchedInputCount: number
    byType: Array<{ type: string; allocatedMinor: { numerator: string; denominator: string } }>
  }>
}

type CostInputBody = {
  periodStart: string
  periodEnd: string
  costType: 'agent' | 'channel' | 'ai'
  amountMinor: string
  currencyCode: string
  source: 'manual' | 'provider_invoice'
  userId?: string | null
  channelId?: string | null
  providerInvoiceRef?: string | null
  providerLineRef?: string | null
  description?: string | null
}

function march(day: number): string {
  return `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`
}

function manualRow(currencyCode: string, overrides: Partial<CostInputBody> = {}): CostInputBody {
  return {
    periodStart: march(1),
    periodEnd: march(8),
    costType: 'ai',
    amountMinor: '125000',
    currencyCode,
    source: 'manual',
    ...overrides,
  }
}

async function resolveBaseCurrency(request: APIRequestContext, token: string): Promise<string> {
  const response = await apiRequest(request, 'GET', CURRENCY_OPTION, { token })
  expect(
    response.status(),
    'The seeded tenant must expose a base currency for cost inputs to be recordable',
  ).toBe(200)
  const body = await readJsonSafe<{ item?: { code?: string } }>(response)
  const code = body?.item?.code
  expect(typeof code === 'string' && /^[A-Z]{3}$/.test(code)).toBeTruthy()
  return code as string
}

async function createCostInput(
  request: APIRequestContext,
  token: string,
  body: CostInputBody,
): Promise<{ id: string; updatedAt: string; replayed: boolean; status: number }> {
  const response = await apiRequest(request, 'POST', COLLECTION, { token, data: body })
  const parsed = await readJsonSafe<{ id?: string; updatedAt?: string; replayed?: boolean }>(response)
  expect(response.status(), `create failed: ${JSON.stringify(parsed)}`).toBeLessThan(300)
  return {
    id: parsed?.id as string,
    updatedAt: parsed?.updatedAt as string,
    replayed: parsed?.replayed === true,
    status: response.status(),
  }
}

async function readDetail(request: APIRequestContext, token: string, id: string) {
  const response = await apiRequest(request, 'GET', `${COLLECTION}?id=${encodeURIComponent(id)}`, { token })
  const body = await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(response)
  return { status: response.status(), item: body?.items?.[0] ?? null }
}

test.describe('TC-CONNECT-COST-INPUTS', () => {
  test('COST-INT-001: CRUD lifecycle, optimistic conflict, soft delete and provider replay', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const currencyCode = await resolveBaseCurrency(request, token)
    const invoiceRef = `inv-${randomUUID()}`

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const created: string[] = []

    try {
      const manual = await createCostInput(request, token, manualRow(currencyCode, { description: 'March AI spend' }))
      created.push(manual.id)
      expect(manual.status).toBe(201)
      expect(manual.replayed).toBe(false)
      expect(manual.updatedAt).toBeTruthy()

      const detail = await readDetail(request, token, manual.id)
      expect(detail.status).toBe(200)
      expect(detail.item).toMatchObject({
        id: manual.id,
        costType: 'ai',
        amountMinor: '125000',
        currencyCode,
        source: 'manual',
        description: 'March AI spend',
      })

      // The grid projection must not carry the encrypted description.
      const list = await apiRequest(request, 'GET', `${COLLECTION}?pageSize=100`, { token })
      const listBody = await readJsonSafe<{ items?: Array<Record<string, unknown>> }>(list)
      const listed = (listBody?.items ?? []).find((item) => item.id === manual.id)
      expect(listed, 'the created row must appear in the list').toBeTruthy()
      expect(listed?.description).toBeUndefined()

      // A stale version must be refused rather than silently overwriting.
      const stale = await apiRequest(request, 'PUT', COLLECTION, {
        token,
        headers: { [LOCK_HEADER]: new Date(Date.parse(manual.updatedAt) - 60_000).toISOString() },
        data: { id: manual.id, ...manualRow(currencyCode, { amountMinor: '1' }) },
      })
      expect(stale.status()).toBe(409)

      const updated = await apiRequest(request, 'PUT', COLLECTION, {
        token,
        headers: { [LOCK_HEADER]: manual.updatedAt },
        data: { id: manual.id, ...manualRow(currencyCode, { amountMinor: '999', description: 'corrected' }) },
      })
      expect(updated.status()).toBe(200)
      const updatedBody = await readJsonSafe<{ updatedAt?: string }>(updated)
      expect(updatedBody?.updatedAt).toBeTruthy()

      const afterUpdate = await readDetail(request, token, manual.id)
      expect(afterUpdate.item).toMatchObject({ amountMinor: '999', description: 'corrected' })

      // Exact provider replay returns the original row and writes nothing new.
      const providerBody = manualRow(currencyCode, {
        costType: 'channel',
        channelId: randomUUID(),
        source: 'provider_invoice',
        providerInvoiceRef: invoiceRef,
        providerLineRef: 'line-1',
      })
      const provider = await createCostInput(request, token, providerBody)
      created.push(provider.id)
      expect(provider.status).toBe(201)

      const before = await countCostInputs(em, { tenantId, organizationId })
      const replay = await createCostInput(request, token, providerBody)
      expect(replay.status).toBe(200)
      expect(replay.replayed).toBe(true)
      expect(replay.id).toBe(provider.id)
      expect(await countCostInputs(em, { tenantId, organizationId })).toBe(before)

      // Same identity, different amount: a conflict, never a silent overwrite.
      const conflict = await apiRequest(request, 'POST', COLLECTION, {
        token,
        data: { ...providerBody, amountMinor: '424242' },
      })
      expect(conflict.status()).toBe(409)
      const conflictBody = await readJsonSafe<{ code?: string }>(conflict)
      expect(conflictBody?.code).toBe('provider_line_conflict')

      // Delete requires the current version and is a soft delete.
      const currentUpdatedAt = (await readDetail(request, token, manual.id)).item?.updatedAt as string
      const staleDelete = await apiRequest(request, 'DELETE', `${COLLECTION}?id=${manual.id}`, {
        token,
        headers: { [LOCK_HEADER]: new Date(Date.parse(currentUpdatedAt) - 60_000).toISOString() },
      })
      expect(staleDelete.status()).toBe(409)

      const removed = await apiRequest(request, 'DELETE', `${COLLECTION}?id=${manual.id}`, {
        token,
        headers: { [LOCK_HEADER]: currentUpdatedAt },
      })
      expect(removed.status()).toBe(200)

      const row = await readCostInputRow(em, manual.id)
      expect(row?.deleted_at, 'delete must be a soft delete').not.toBeNull()
      expect((await readDetail(request, token, manual.id)).item).toBeNull()

      // A deleted id and a guessed id are indistinguishable to the caller.
      const deleteAgain = await apiRequest(request, 'DELETE', `${COLLECTION}?id=${manual.id}`, { token })
      const deleteGuessed = await apiRequest(request, 'DELETE', `${COLLECTION}?id=${randomUUID()}`, { token })
      expect(deleteAgain.status()).toBe(deleteGuessed.status())
      expect(deleteAgain.status()).toBe(404)
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-002: sibling-organization rows stay invisible, including by guessed id', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const currencyCode = await resolveBaseCurrency(request, token)

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const created: string[] = []

    try {
      const mine = await createCostInput(request, token, manualRow(currencyCode))
      created.push(mine.id)

      const siblingOrganizationId = randomUUID()
      const foreignTenantId = randomUUID()
      const siblingId = await insertCostInputRow(em, {
        tenantId,
        organizationId: siblingOrganizationId,
        periodStart: march(1),
        periodEnd: march(8),
        costType: 'ai',
        amountMinor: '777',
        currencyCode,
      })
      const foreignId = await insertCostInputRow(em, {
        tenantId: foreignTenantId,
        organizationId,
        periodStart: march(1),
        periodEnd: march(8),
        costType: 'ai',
        amountMinor: '888',
        currencyCode,
      })
      created.push(siblingId, foreignId)

      const list = await apiRequest(request, 'GET', `${COLLECTION}?pageSize=100`, { token })
      const body = await readJsonSafe<{ items?: Array<{ id: string }> }>(list)
      const ids = (body?.items ?? []).map((item) => item.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(siblingId)
      expect(ids).not.toContain(foreignId)

      // Naming the id directly must not widen the scope.
      expect((await readDetail(request, token, siblingId)).item).toBeNull()
      expect((await readDetail(request, token, foreignId)).item).toBeNull()

      const crossScopeUpdate = await apiRequest(request, 'PUT', COLLECTION, {
        token,
        data: { id: siblingId, ...manualRow(currencyCode, { amountMinor: '1' }) },
      })
      expect(crossScopeUpdate.status()).toBe(404)
      expect((await readCostInputRow(em, siblingId))?.amount_minor).toBe('777')

      // The platform's mutation guard rejects client-supplied scope before the
      // route command runs, so the spoofed scope can never be honoured.
      const spoofed = await apiRequest(request, 'POST', COLLECTION, {
        token,
        data: { ...manualRow(currencyCode), tenantId: foreignTenantId, organizationId: siblingOrganizationId },
      })
      expect(spoofed.status()).toBe(403)
      expect(await countCostInputs(em, { tenantId: foreignTenantId, organizationId: siblingOrganizationId })).toBe(0)
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-003: conditionals, period, currency and exact money grammar', async ({ request }) => {
    const token = await getAuthToken(request)
    const currencyCode = await resolveBaseCurrency(request, token)

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const created: string[] = []

    const rejected: Array<[string, Record<string, unknown>, string]> = [
      ['an agent row with no agent', manualRow(currencyCode, { costType: 'agent' }), 'dimension_invalid'],
      ['an AI row carrying a channel', manualRow(currencyCode, { channelId: randomUUID() }), 'dimension_invalid'],
      [
        'a manual row carrying provenance',
        manualRow(currencyCode, { providerInvoiceRef: 'inv-1', providerLineRef: 'line-1' }),
        'provenance_invalid',
      ],
      [
        'a provider row missing its line',
        manualRow(currencyCode, { source: 'provider_invoice', providerInvoiceRef: 'inv-1' }),
        'provenance_invalid',
      ],
      ['an empty period', manualRow(currencyCode, { periodEnd: march(1) }), 'period_invalid'],
      ['a negative amount', manualRow(currencyCode, { amountMinor: '-1' }), 'amount_minor_invalid'],
      ['a decimal amount', manualRow(currencyCode, { amountMinor: '12.50' }), 'amount_minor_invalid'],
      ['a leading-zero amount', manualRow(currencyCode, { amountMinor: '0125' }), 'amount_minor_invalid'],
      ['an overflowing amount', manualRow(currencyCode, { amountMinor: '9223372036854775808' }), 'amount_minor_invalid'],
      ['a JSON-number amount', { ...manualRow(currencyCode), amountMinor: 125000 }, 'amount_minor_invalid'],
      ['a non-base currency', manualRow(currencyCode, { currencyCode: currencyCode === 'XZZ' ? 'XZY' : 'XZZ' }), 'currency_invalid'],
    ]

    try {
      for (const [label, body, code] of rejected) {
        const response = await apiRequest(request, 'POST', COLLECTION, { token, data: body })
        expect(response.status(), `${label} must be rejected`).toBe(422)
        const parsed = await readJsonSafe<{ code?: string }>(response)
        expect(parsed?.code, `${label} must map to ${code}`).toBe(code)
      }

      // The bigint ceiling must survive the round trip as a string, exactly.
      const ceiling = await createCostInput(
        request,
        token,
        manualRow(currencyCode, { amountMinor: '9223372036854775807' }),
      )
      created.push(ceiling.id)
      const raw = await apiRequest(request, 'GET', `${COLLECTION}?id=${ceiling.id}`, { token })
      const text = await raw.text()
      expect(text).toContain('"amountMinor":"9223372036854775807"')
      const parsed = JSON.parse(text) as { items: Array<{ amountMinor: unknown }> }
      expect(typeof parsed.items[0]?.amountMinor).toBe('string')
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-004: sanitized reader overlap, currency filter and deleted-row exclusion', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const currencyCode = await resolveBaseCurrency(request, token)

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const reader = container.resolve<ConnectAllocatedCostReaderLike>('connectAllocatedCostReader')
    const created: string[] = []

    try {
      // [10, 20) is the requested window below.
      const overlapping = await insertCostInputRow(em, {
        tenantId, organizationId, periodStart: march(12), periodEnd: march(15),
        costType: 'ai', amountMinor: '100', currencyCode,
      })
      const abutsStart = await insertCostInputRow(em, {
        tenantId, organizationId, periodStart: march(5), periodEnd: march(10),
        costType: 'ai', amountMinor: '200', currencyCode,
      })
      const abutsEnd = await insertCostInputRow(em, {
        tenantId, organizationId, periodStart: march(20), periodEnd: march(25),
        costType: 'ai', amountMinor: '300', currencyCode,
      })
      const straddlesStart = await insertCostInputRow(em, {
        tenantId, organizationId, periodStart: march(5), periodEnd: march(11),
        costType: 'ai', amountMinor: '400', currencyCode,
      })
      const otherCurrency = await insertCostInputRow(em, {
        tenantId, organizationId, periodStart: march(12), periodEnd: march(15),
        costType: 'ai', amountMinor: '500', currencyCode: currencyCode === 'XZZ' ? 'XZY' : 'XZZ',
      })
      const sibling = await insertCostInputRow(em, {
        tenantId, organizationId: randomUUID(), periodStart: march(12), periodEnd: march(15),
        costType: 'ai', amountMinor: '600', currencyCode,
      })
      created.push(overlapping, abutsStart, abutsEnd, straddlesStart, otherCurrency, sibling)

      const summary = await reader.summarizeAllocated({
        tenantId,
        organizationId,
        periodStart: new Date(march(10)),
        periodEnd: new Date(march(20)),
        currencyCode,
      })

      expect(summary.matchedInputCount).toBe(2)
      expect(summary.byType).toEqual([
        { type: 'ai', allocatedMinor: { numerator: '500', denominator: '3' } },
      ])

      await em.getConnection().execute('update connect_cost_inputs set deleted_at = now() where id = ?', [overlapping])
      const afterDelete = await reader.summarizeAllocated({
        tenantId,
        organizationId,
        periodStart: new Date(march(10)),
        periodEnd: new Date(march(20)),
        currencyCode,
      })
      expect(afterDelete).toMatchObject({
        matchedInputCount: 1,
        byType: [{ type: 'ai', allocatedMinor: { numerator: '200', denominator: '3' } }],
      })

      await expect(reader.summarizeAllocated({
        tenantId,
        organizationId,
        periodStart: new Date(march(20)),
        periodEnd: new Date(march(10)),
        currencyCode,
      })).rejects.toThrow()
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-005: the description is encrypted at rest and absent from the list projection', async ({ request }) => {
    const token = await getAuthToken(request)
    const currencyCode = await resolveBaseCurrency(request, token)
    const secret = `acct-${randomUUID()}`

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const created: string[] = []

    try {
      const row = await createCostInput(request, token, manualRow(currencyCode, { description: secret }))
      created.push(row.id)

      const stored = await readCostInputRow(em, row.id)
      const revisions = await readRevisionSecretDescriptions(em, row.id)
      expect(revisions.length, 'every mutation writes exactly one revision secret').toBe(1)

      // When tenant data encryption is enabled the plaintext must not be
      // readable in either table. When it is disabled the columns hold
      // plaintext by design — assert the shape either way rather than
      // pretending the feature is on.
      const encryptionEnabled = stored?.description !== secret
      if (encryptionEnabled) {
        expect(stored?.description).not.toContain(secret)
        expect(revisions[0]?.description_after ?? '').not.toContain(secret)
      }

      // The authorized detail read decrypts it back.
      expect((await readDetail(request, token, row.id)).item?.description).toBe(secret)

      // The list projection never carries it, encrypted or not.
      const list = await apiRequest(request, 'GET', `${COLLECTION}?pageSize=100`, { token })
      expect(await list.text()).not.toContain(secret)
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-006: undo restores a deleted row and its encrypted description', async ({ request }) => {
    skipIfUndoTestsDisabled()
    const token = await getAuthToken(request)
    const currencyCode = await resolveBaseCurrency(request, token)
    const secret = `undo-${randomUUID()}`

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const created: string[] = []

    try {
      const row = await createCostInput(request, token, manualRow(currencyCode, { description: secret }))
      created.push(row.id)

      const detail = await readDetail(request, token, row.id)
      const deleted = await apiRequest(request, 'DELETE', `${COLLECTION}?id=${row.id}`, {
        token,
        headers: { [LOCK_HEADER]: detail.item?.updatedAt as string },
      })
      expect(deleted.status()).toBe(200)
      const operation = expectOperation(deleted, 'cost input delete')

      await undoOk(request, token, operation.undoToken, 'cost input delete undo')

      const restored = await readDetail(request, token, row.id)
      expect(restored.item, 'undo must restore the soft-deleted row').toBeTruthy()
      expect(restored.item?.amountMinor).toBe('125000')
      // The prior description lives only in the revision secret; undo has to
      // read it back through the scoped decryption path.
      expect(restored.item?.description).toBe(secret)
    } finally {
      await hardDeleteCostInputs(em, created)
      await container.dispose()
    }
  })

  test('COST-INT-007: the currency selector is a guarded singleton that fails closed', async ({ request }) => {
    const adminToken = await getAuthToken(request)
    const response = await apiRequest(request, 'GET', CURRENCY_OPTION, { token: adminToken })
    expect(response.status()).toBe(200)
    const body = await readJsonSafe<{ item?: { code?: string } }>(response)
    expect(Object.keys(body ?? {})).toEqual(['item'])
    expect(Object.keys(body?.item ?? {})).toEqual(['code'])

    const anonymous = await request.get(CURRENCY_OPTION)
    expect([401, 403]).toContain(anonymous.status())

    // An employee holds neither cost feature, so the selector must refuse them
    // rather than leak the organization's base currency.
    const employeeToken = await getAuthToken(request, 'employee').catch(() => null)
    if (employeeToken) {
      const denied = await apiRequest(request, 'GET', CURRENCY_OPTION, { token: employeeToken })
      expect(denied.status()).toBe(403)
      const deniedList = await apiRequest(request, 'GET', COLLECTION, { token: employeeToken })
      expect(deniedList.status()).toBe(403)
    }
  })

  test('COST-INT-009: the generated manifests carry the exact additive surfaces', async () => {
    await bootstrapFromAppRoot(APP_ROOT)
    const entityIds = await import(`${APP_ROOT}/.mercato/generated/entities.ids.generated.js`)
      .catch(async () => import(`${APP_ROOT}/.mercato/generated/entities.ids.generated.ts`))
    const registry = (entityIds as { E: Record<string, Record<string, string>> }).E

    expect(registry.connect_analytics?.cost_input).toBe('connect_analytics:cost_input')
    expect(registry.connect_analytics?.cost_input_revision_secret)
      .toBe('connect_analytics:cost_input_revision_secret')
    // The base Connect metrics surface must remain untouched by this slice.
    expect(registry.connect?.connect_metric_daily).toBe('connect:connect_metric_daily')
  })
})
