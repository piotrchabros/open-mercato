/** @jest-environment node */

jest.mock('@open-mercato/shared/lib/commands/flush', () => ({
  withAtomicFlush: async (
    _em: unknown,
    phases: Array<() => unknown | Promise<unknown>>,
  ) => {
    for (const phase of phases) await phase()
  },
}))

jest.mock('@open-mercato/core/modules/directory/lib/hierarchy', () => {
  const actual = jest.requireActual('@open-mercato/core/modules/directory/lib/hierarchy')
  return {
    ...actual,
    rebuildHierarchyForTenant: jest.fn(async () => {}),
  }
})

jest.mock('@open-mercato/shared/lib/commands/helpers', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/commands/helpers')
  return {
    ...actual,
    emitCrudSideEffects: jest.fn(async () => {}),
    emitCrudUndoSideEffects: jest.fn(async () => {}),
  }
})

jest.mock('@open-mercato/shared/lib/commands/customFieldSnapshots', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/commands/customFieldSnapshots')
  return {
    ...actual,
    loadCustomFieldSnapshot: jest.fn(async () => ({})),
  }
})

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(
    async (em: { findOne: (entity: unknown, filter: unknown) => Promise<unknown> }, entity: unknown, filter: unknown) =>
      em.findOne(entity, filter),
  ),
  findWithDecryption: jest.fn(
    async (em: { find: (entity: unknown, filter: unknown) => Promise<unknown> }, entity: unknown, filter: unknown) =>
      em.find(entity, filter),
  ),
}))

import '@open-mercato/core/modules/directory/commands/organizations'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import type { CommandUndoLogEntry } from '@open-mercato/shared/lib/commands/types'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = 'aaaa1111-0000-4000-8000-000000000001'
const OTHER_ORG_ID = 'aaaa1111-0000-4000-8000-000000000002'
const CURRENT_URL = 'https://crm.example.com'
const NEXT_URL = 'https://app.example.com'
const TAKEN_URL = 'https://other.example.com'

type OrgRow = {
  id: string
  tenant: string
  name: string
  slug: string | null
  logoUrl: string | null
  logoPreserveAspectRatio: boolean
  appUrl: string | null
  isActive: boolean
  deletedAt: Date | null
  parentId: string | null
  ancestorIds: string[]
  childIds: string[]
  descendantIds: string[]
}

function makeRow(id: string, name: string, overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id,
    tenant: TENANT_ID,
    name,
    slug: null,
    logoUrl: null,
    logoPreserveAspectRatio: true,
    appUrl: null,
    isActive: true,
    deletedAt: null,
    parentId: null,
    ancestorIds: [],
    childIds: [],
    descendantIds: [],
    ...overrides,
  }
}

function makeRows(): OrgRow[] {
  return [
    makeRow(ORG_ID, 'Acme', { appUrl: CURRENT_URL }),
    makeRow(OTHER_ORG_ID, 'Other', { appUrl: TAKEN_URL }),
  ]
}

type RowFilter = {
  id?: string | { $in: string[] } | { $ne: string }
  parentId?: string
  appUrl?: string
}

function matches(row: OrgRow, filter: RowFilter): boolean {
  if (row.deletedAt) return false
  if (typeof filter.id === 'string' && row.id !== filter.id) return false
  if (filter.id && typeof filter.id === 'object') {
    if ('$in' in filter.id && !filter.id.$in.includes(row.id)) return false
    if ('$ne' in filter.id && row.id === filter.id.$ne) return false
  }
  if (filter.parentId !== undefined && row.parentId !== filter.parentId) return false
  if (filter.appUrl !== undefined && row.appUrl !== filter.appUrl) return false
  return true
}

function makeEm(rows: OrgRow[]) {
  const em = {
    findOne: jest.fn(async (_entity: unknown, filter: RowFilter) => rows.find((row) => matches(row, filter)) ?? null),
    find: jest.fn(async (_entity: unknown, filter: RowFilter) => rows.filter((row) => matches(row, filter))),
    flush: jest.fn(async () => {}),
    persist: jest.fn(() => ({ flush: jest.fn(async () => {}) })),
    fork: jest.fn(() => em),
  }
  return em
}

function makeDataEngine(rows: OrgRow[]) {
  return {
    updateOrmEntity: jest.fn(async ({ where, apply }: { where: RowFilter; apply: (entity: OrgRow) => void }) => {
      const row = rows.find((candidate) => matches(candidate, where)) ?? null
      if (row) apply(row)
      return row
    }),
    deleteOrmEntity: jest.fn(async ({ where }: { where: RowFilter }) => {
      const row = rows.find((candidate) => matches(candidate, where)) ?? null
      if (row) row.deletedAt = new Date()
      return row
    }),
    setCustomFields: jest.fn(async () => {}),
  }
}

type Actor = { isSuperAdmin: boolean; hasAppUrlFeature: boolean }

function makeHarness(rows: OrgRow[], actor: Actor) {
  const em = makeEm(rows)
  const de = makeDataEngine(rows)
  const resolver = { invalidate: jest.fn(async () => {}) }
  const rbacService = {
    loadAcl: jest.fn(async () => ({ isSuperAdmin: actor.isSuperAdmin })),
    userHasAllFeatures: jest.fn(async () => actor.hasAppUrlFeature),
  }
  const ctx = {
    container: {
      resolve: (token: string) => {
        if (token === 'em') return em
        if (token === 'dataEngine') return de
        if (token === 'rbacService') return rbacService
        if (token === 'organizationAppUrlResolver') return resolver
        throw new Error(`[internal] Unexpected DI token: ${token}`)
      },
    },
    auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID, isSuperAdmin: actor.isSuperAdmin },
  } as unknown as Parameters<CommandHandler['execute']>[1]
  return { em, de, resolver, rbacService, ctx }
}

const ADMIN: Actor = { isSuperAdmin: false, hasAppUrlFeature: false }
const SUPERADMIN: Actor = { isSuperAdmin: true, hasAppUrlFeature: false }

function updateHandler(): CommandHandler {
  return commandRegistry.get('directory.organizations.update') as CommandHandler
}

function deleteHandler(): CommandHandler {
  return commandRegistry.get('directory.organizations.delete') as CommandHandler
}

function appUrlOf(rows: OrgRow[], id: string): string | null | undefined {
  return rows.find((row) => row.id === id)?.appUrl
}

async function captureRejection(run: Promise<unknown>): Promise<CrudHttpError> {
  const rejection = await run.catch((err: unknown) => err)
  expect(rejection).toBeInstanceOf(CrudHttpError)
  return rejection as CrudHttpError
}

describe('directory.organizations.update — organization app URL', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      APP_URL: CURRENT_URL,
      APP_ALLOWED_ORIGINS: [NEXT_URL, TAKEN_URL].join(','),
    }
  })

  afterEach(() => {
    process.env = originalEnv
    jest.clearAllMocks()
  })

  it('rejects an admin without the feature with 403 before any write', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, ADMIN)

    const rejection = await captureRejection(updateHandler().execute({ id: ORG_ID, appUrl: NEXT_URL }, harness.ctx))

    expect(rejection.status).toBe(403)
    expect(rejection.body).toEqual(expect.objectContaining({ code: 'directory.organizations.errors.appUrlForbidden' }))
    expect(harness.de.updateOrmEntity).not.toHaveBeenCalled()
    expect(harness.resolver.invalidate).not.toHaveBeenCalled()
    expect(appUrlOf(rows, ORG_ID)).toBe(CURRENT_URL)
  })

  it('lets an admin without the feature resend the same address', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, ADMIN)

    await updateHandler().execute({ id: ORG_ID, name: 'Renamed', appUrl: `${CURRENT_URL.toUpperCase()}/` }, harness.ctx)

    expect(harness.de.updateOrmEntity).toHaveBeenCalledTimes(1)
    expect(rows.find((row) => row.id === ORG_ID)?.name).toBe('Renamed')
    expect(appUrlOf(rows, ORG_ID)).toBe(CURRENT_URL)
    expect(harness.resolver.invalidate).not.toHaveBeenCalled()
  })

  it('lets an admin holding the feature change the address', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, { isSuperAdmin: false, hasAppUrlFeature: true })

    await updateHandler().execute({ id: ORG_ID, appUrl: NEXT_URL }, harness.ctx)

    expect(appUrlOf(rows, ORG_ID)).toBe(NEXT_URL)
  })

  it('lets a superadmin change and clear the address and invalidates the resolver', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)

    await updateHandler().execute({ id: ORG_ID, appUrl: `${NEXT_URL}/` }, harness.ctx)
    expect(appUrlOf(rows, ORG_ID)).toBe(NEXT_URL)
    expect(harness.resolver.invalidate).toHaveBeenCalledWith(ORG_ID)

    await updateHandler().execute({ id: ORG_ID, appUrl: '' }, harness.ctx)
    expect(appUrlOf(rows, ORG_ID)).toBeNull()
    expect(harness.resolver.invalidate).toHaveBeenCalledTimes(2)
  })

  it('rejects an address another organization uses with 409', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)

    const rejection = await captureRejection(updateHandler().execute({ id: ORG_ID, appUrl: TAKEN_URL }, harness.ctx))

    expect(rejection.status).toBe(409)
    expect(rejection.body).toEqual(expect.objectContaining({
      code: 'directory.organizations.errors.appUrlTaken',
      fieldErrors: { appUrl: expect.any(String) },
    }))
    expect(harness.de.updateOrmEntity).not.toHaveBeenCalled()
    expect(appUrlOf(rows, ORG_ID)).toBe(CURRENT_URL)
  })

  it('maps a unique violation raised during the write to 409', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)
    harness.de.updateOrmEntity.mockImplementationOnce(async () => {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "organizations_app_url_uniq"'),
        { code: '23505' },
      )
    })

    const rejection = await captureRejection(updateHandler().execute({ id: ORG_ID, appUrl: NEXT_URL }, harness.ctx))

    expect(rejection.status).toBe(409)
    expect(rejection.body).toEqual(expect.objectContaining({ code: 'directory.organizations.errors.appUrlTaken' }))
    expect(harness.resolver.invalidate).not.toHaveBeenCalled()
  })

  it('rejects an invalid address with 422 and field errors', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)

    const rejection = await captureRejection(
      updateHandler().execute({ id: ORG_ID, appUrl: 'https://crm.example.com/path' }, harness.ctx),
    )

    expect(rejection.status).toBe(422)
    expect(rejection.body).toEqual(expect.objectContaining({
      code: 'directory.organizations.errors.appUrlInvalid',
      fieldErrors: { appUrl: expect.any(String) },
    }))
    expect(harness.de.updateOrmEntity).not.toHaveBeenCalled()
  })

  it('rejects an address this installation does not serve with 422', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)

    const rejection = await captureRejection(
      updateHandler().execute({ id: ORG_ID, appUrl: 'https://unknown.example.org' }, harness.ctx),
    )

    expect(rejection.status).toBe(422)
    expect(rejection.body).toEqual(expect.objectContaining({ code: 'directory.organizations.errors.appUrlNotAllowed' }))
  })

  it('records the address change in the audit log but not in the undo snapshot', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)
    const handler = updateHandler()
    const input = { id: ORG_ID, appUrl: NEXT_URL }

    const prepared = await handler.prepare!(input, harness.ctx)
    const result = await handler.execute(input, harness.ctx)
    const log = await handler.buildLog!({ input, result, ctx: harness.ctx, snapshots: { before: prepared?.before } })

    expect(log?.changes).toEqual(expect.objectContaining({ appUrl: { from: CURRENT_URL, to: NEXT_URL } }))
    const undoPayload = (log?.payload as { undo: { before: Record<string, unknown>; after: Record<string, unknown> } }).undo
    expect(undoPayload.before).not.toHaveProperty('appUrl')
    expect(undoPayload.after).not.toHaveProperty('appUrl')

    const entry: CommandUndoLogEntry = { commandPayload: log?.payload }
    await handler.undo!({ input, logEntry: entry, ctx: makeHarness(rows, ADMIN).ctx })

    expect(appUrlOf(rows, ORG_ID)).toBe(NEXT_URL)
  })
})

describe('directory.organizations.delete — organization app URL', () => {
  afterEach(() => jest.clearAllMocks())

  it('invalidates the resolver after a delete', async () => {
    const rows = makeRows()
    const harness = makeHarness(rows, SUPERADMIN)

    await deleteHandler().execute({ body: { id: ORG_ID }, query: {} }, harness.ctx)

    expect(harness.resolver.invalidate).toHaveBeenCalledWith(ORG_ID)
  })
})
