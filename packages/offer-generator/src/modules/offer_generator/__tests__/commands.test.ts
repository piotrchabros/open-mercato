import { randomUUID } from 'crypto'
import type { AwilixContainer } from 'awilix'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { Offer, OfferGeneratorSettings, OfferRevision } from '../data/entities'
import {
  OFFER_COMMAND_IDS,
  type OfferCommandResult,
  type OfferHtmlCommandInput,
  type OfferHtmlCommandResult,
} from '../commands/offers'
import {
  SETTINGS_COMMAND_IDS,
  type SettingsUpsertCommandInput,
  type SettingsUpsertResult,
} from '../commands/settings'
import '../commands'
import { serializeOffer } from '../lib/serializers'
import type { OfferCreateInput, OfferUpdateInput } from '../data/validators'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (key: string) => key,
  })),
}))
jest.mock('@open-mercato/shared/lib/commands/runCrudCommandWrite', () => ({
  runCrudCommandWrite: jest.fn(
    async (opts: {
      em: unknown
      phases: Array<(args: { em: unknown }) => void | Promise<void>>
      sideEffect: () => unknown
    }) => {
      for (const phase of opts.phases) await phase({ em: opts.em })
      opts.sideEffect()
      return { em: opts.em }
    },
  ),
}))

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const offerId = '33333333-3333-4333-8333-333333333333'
const offerUpdatedAt = new Date('2026-11-04T10:00:00.000Z')

const findOne = findOneWithDecryption as jest.Mock
const runWrite = runCrudCommandWrite as jest.Mock

type SqlCall = { sql: string; params: unknown[] }

function buildHtml(marker: string, extra = ''): string {
  const paragraph = `<p>${marker} ${'Offer content describing services and pricing in detail. '.repeat(6)}</p>`
  return `<!DOCTYPE html><html lang="pl"><head><title>${marker}</title><style>.card{color:#111}</style></head><body><section class="card">${paragraph}${extra}</section></body></html>`
}

function buildOffer(overrides: Partial<Offer> = {}): Offer {
  const offer = new Offer()
  Object.assign(offer, {
    id: offerId,
    ...scope,
    ownerUserId: userId,
    title: 'Website offer',
    clientName: 'Acme Sp. z o.o.',
    language: 'pl',
    status: 'draft',
    slug: 'acme-sp-z-o-o-2026-11',
    accessToken: 'abcdefghijk1',
    html: null,
    htmlUpdatedAt: null,
    viewCount: 0,
    generationStatus: 'idle',
    createdAt: offerUpdatedAt,
    updatedAt: offerUpdatedAt,
    deletedAt: null,
    ...overrides,
  })
  return offer
}

type HarnessOptions = {
  offer?: Offer | null
  settings?: OfferGeneratorSettings | null
  takenSlugs?: string[]
}

function buildHarness(options: HarnessOptions = {}) {
  const offer = options.offer === undefined ? buildOffer() : options.offer
  const settings = options.settings ?? null
  const persisted: object[] = []
  const removed: object[] = []
  const sqlCalls: SqlCall[] = []

  findOne.mockImplementation(
    async (
      _em: unknown,
      entity: unknown,
      where: { id?: string; tenantId?: string; organizationId?: string | { $in: string[] } },
    ) => {
      if (where.tenantId && where.tenantId !== scope.tenantId) return null
      if (entity === Offer) {
        if (!offer || offer.id !== where.id) return null
        const orgFilter = where.organizationId
        if (typeof orgFilter === 'string' && orgFilter !== offer.organizationId) return null
        if (orgFilter && typeof orgFilter === 'object' && !orgFilter.$in.includes(offer.organizationId)) return null
        return offer
      }
      if (entity === OfferGeneratorSettings) return settings
      return null
    },
  )

  const em = {
    fork: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    persist: jest.fn((entity: object) => {
      persisted.push(entity)
    }),
    remove: jest.fn((entity: object) => {
      removed.push(entity)
    }),
    create: jest.fn(<T extends object>(entityClass: new () => T, data: Record<string, unknown>): T => {
      const instance = new entityClass()
      Object.assign(instance, { id: randomUUID() }, data)
      return instance
    }),
    getConnection: () => ({
      execute: jest.fn(async (sql: string, params: unknown[] = []) => {
        sqlCalls.push({ sql, params })
        if (sql.startsWith('select slug')) return (options.takenSlugs ?? []).map((slug) => ({ slug }))
        return []
      }),
    }),
  }
  em.fork.mockReturnValue(em)

  const services: Record<string, unknown> = {
    em,
    dataEngine: { markOrmEntityChange: jest.fn() },
  }
  const container = {
    resolve: (name: string) => {
      if (!(name in services)) throw new Error(`missing ${name}`)
      return services[name]
    },
  } as unknown as AwilixContainer
  return { container, offer, persisted, removed, sqlCalls, em }
}

function buildCtx(container: AwilixContainer): CommandRuntimeContext {
  return {
    container,
    auth: { sub: userId, tenantId: scope.tenantId, orgId: scope.organizationId } as CommandRuntimeContext['auth'],
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
}

function handler<TInput, TResult>(id: string): CommandHandler<TInput, TResult> {
  const found = commandRegistry.get(id)
  if (!found) throw new Error(`command ${id} not registered`)
  return found as CommandHandler<TInput, TResult>
}

async function expectHttpError(promise: Promise<unknown>, status: number): Promise<Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    if (!isCrudHttpError(error)) throw error
    expect(error.status).toBe(status)
    return error.body
  }
  throw new Error('expected command to fail')
}

const createOffer = handler<OfferCreateInput, OfferCommandResult>(OFFER_COMMAND_IDS.create)
const updateOffer = handler<OfferUpdateInput, OfferCommandResult>(OFFER_COMMAND_IDS.update)
const deleteOffer = handler<{ id: string }, OfferCommandResult>(OFFER_COMMAND_IDS.delete)
const updateHtml = handler<OfferHtmlCommandInput, OfferHtmlCommandResult>(OFFER_COMMAND_IDS.updateHtml)
const upsertSettings = handler<SettingsUpsertCommandInput, SettingsUpsertResult>(SETTINGS_COMMAND_IDS.upsert)

describe('offer_generator commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('registers every command id', () => {
    for (const id of [...Object.values(OFFER_COMMAND_IDS), SETTINGS_COMMAND_IDS.upsert]) {
      expect(commandRegistry.get(id)).toBeTruthy()
    }
  })

  it('create generates a unique slug and an access token and applies settings defaults', async () => {
    const now = new Date()
    const base = `acme-sp-z-o-o-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const taken = buildHarness({ takenSlugs: [base] })
    const result = await createOffer.execute(
      { ...scope, title: 'Website offer', clientName: 'Acme Sp. z o.o.', language: 'en', valueAmount: 1234.5 },
      buildCtx(taken.container),
    )

    const created = taken.persisted.find((entity): entity is Offer => entity instanceof Offer)
    expect(created).toBeDefined()
    expect(result.offerId).toBe(created?.id)
    expect(created?.slug).toBe(`${base}-2`)
    expect(created?.accessToken).toMatch(/^[a-z0-9]{12}$/)
    expect(created).toMatchObject({
      ...scope,
      ownerUserId: userId,
      language: 'en',
      status: 'draft',
      currencyCode: 'PLN',
      valueAmount: '1234.50',
    })
    expect(runWrite.mock.calls[0][0]).toMatchObject({
      action: 'created',
      entityId: 'offer_generator:offer',
      indexer: { entityType: 'offer_generator:offer' },
      events: { module: 'offer_generator', entity: 'offer' },
    })
  })

  it('update_html stores the previous html as a revision, prunes and sets the sanitized html', async () => {
    const previous = buildHtml('Previous')
    const harness = buildHarness({ offer: buildOffer({ html: previous, htmlUpdatedAt: offerUpdatedAt }) })
    const result = await updateHtml.execute(
      {
        id: offerId,
        html: buildHtml('Next', '<script>alert(1)</script><button onclick="steal()">Go</button>'),
        source: 'refine',
        feedback: 'Shorter intro',
      },
      buildCtx(harness.container),
    )

    const revision = harness.persisted.find((entity): entity is OfferRevision => entity instanceof OfferRevision)
    expect(revision).toMatchObject({
      offerId,
      ...scope,
      html: previous,
      source: 'refine',
      feedback: 'Shorter intro',
      createdByUserId: userId,
    })
    expect(result.revisionId).toBe(revision?.id)
    const prune = harness.sqlCalls.find((call) => call.sql.startsWith('delete from offer_generator_offer_revisions'))
    expect(prune?.params).toEqual([offerId, scope.tenantId, scope.organizationId, 49])
    expect(harness.offer?.html).toContain('Next')
    expect(harness.offer?.html).not.toContain('<script')
    expect(harness.offer?.html).not.toContain('onclick')
    expect(harness.offer?.htmlUpdatedAt).toBeInstanceOf(Date)
    expect(runWrite.mock.calls[0][0]).toMatchObject({ action: 'updated', indexer: { entityType: 'offer_generator:offer' } })
  })

  it('update_html skips the revision when the offer had no html yet', async () => {
    const harness = buildHarness()
    const result = await updateHtml.execute(
      { id: offerId, html: buildHtml('First'), source: 'generate' },
      buildCtx(harness.container),
    )

    expect(result.revisionId).toBeNull()
    expect(harness.persisted.some((entity) => entity instanceof OfferRevision)).toBe(false)
    expect(harness.offer?.html).toContain('First')
  })

  it('update_html rejects incomplete html with a translated issue key', async () => {
    const harness = buildHarness()
    const body = await expectHttpError(
      Promise.resolve(
        updateHtml.execute(
          { id: offerId, html: buildHtml('Cut').replace('</html>', ''), source: 'manual_edit' },
          buildCtx(harness.container),
        ),
      ),
      400,
    )
    expect(body).toMatchObject({ code: 'incomplete_html', issue: 'no-html-close' })
    expect(body.error).toBe('offer_generator.errors.incompleteHtml.no-html-close')
    expect(harness.offer?.html).toBeNull()
  })

  it('update_html rejects html whose body is empty once scripts are stripped', async () => {
    const harness = buildHarness()
    const scriptOnly = `<!DOCTYPE html><html><head></head><body><script>${'x'.repeat(400)}</script></body></html>`
    const body = await expectHttpError(
      Promise.resolve(updateHtml.execute({ id: offerId, html: scriptOnly, source: 'manual_edit' }, buildCtx(harness.container))),
      400,
    )
    expect(body.issue).toBe('empty-body')
  })

  it('update_html returns 409 on a stale expectedUpdatedAt and leaves the html untouched', async () => {
    const previous = buildHtml('Previous')
    const harness = buildHarness({ offer: buildOffer({ html: previous }) })
    const body = await expectHttpError(
      Promise.resolve(
        updateHtml.execute(
          {
            id: offerId,
            html: buildHtml('Next'),
            source: 'manual_edit',
            expectedUpdatedAt: '2026-11-03T09:00:00.000Z',
          },
          buildCtx(harness.container),
        ),
      ),
      409,
    )
    expect(body.currentUpdatedAt).toBe(offerUpdatedAt.toISOString())
    expect(harness.offer?.html).toBe(previous)
    expect(runWrite).not.toHaveBeenCalled()
  })

  it('update_html accepts a matching expectedUpdatedAt', async () => {
    const harness = buildHarness()
    await updateHtml.execute(
      { id: offerId, html: buildHtml('Locked'), source: 'manual_edit', expectedUpdatedAt: offerUpdatedAt.toISOString() },
      buildCtx(harness.container),
    )
    expect(harness.offer?.html).toContain('Locked')
  })

  it('update_html returns 404 for an unknown offer', async () => {
    const harness = buildHarness({ offer: null })
    await expectHttpError(
      Promise.resolve(updateHtml.execute({ id: offerId, html: buildHtml('X'), source: 'generate' }, buildCtx(harness.container))),
      404,
    )
  })

  describe('selected organization scope', () => {
    const otherOrganizationId = '44444444-4444-4444-8444-444444444444'

    function buildSuperAdminCtxForOtherOrg(container: AwilixContainer): CommandRuntimeContext {
      return {
        container,
        auth: {
          sub: userId,
          tenantId: scope.tenantId,
          orgId: otherOrganizationId,
          isSuperAdmin: true,
        } as CommandRuntimeContext['auth'],
        organizationScope: {
          selectedId: otherOrganizationId,
          filterIds: [otherOrganizationId],
          allowedIds: null,
          tenantId: scope.tenantId,
        },
        selectedOrganizationId: otherOrganizationId,
        organizationIds: [otherOrganizationId],
      }
    }

    it('update refuses an offer of another organization with 404 and leaves it untouched', async () => {
      const harness = buildHarness()
      await expectHttpError(
        Promise.resolve(
          updateOffer.execute({ id: offerId, title: 'Hijacked' }, buildSuperAdminCtxForOtherOrg(harness.container)),
        ),
        404,
      )
      expect(harness.offer?.title).toBe('Website offer')
      expect(runWrite).not.toHaveBeenCalled()
    })

    it('delete refuses an offer of another organization with 404 and leaves it untouched', async () => {
      const harness = buildHarness()
      await expectHttpError(
        Promise.resolve(deleteOffer.execute({ id: offerId }, buildSuperAdminCtxForOtherOrg(harness.container))),
        404,
      )
      expect(harness.offer?.deletedAt).toBeNull()
      expect(runWrite).not.toHaveBeenCalled()
    })

    it('update_html refuses an offer of another organization with 404', async () => {
      const harness = buildHarness()
      await expectHttpError(
        Promise.resolve(
          updateHtml.execute(
            { id: offerId, html: buildHtml('Hijacked'), source: 'manual_edit' },
            buildSuperAdminCtxForOtherOrg(harness.container),
          ),
        ),
        404,
      )
      expect(harness.offer?.html).toBeNull()
    })

    it('update still applies inside the selected organization', async () => {
      const harness = buildHarness()
      await updateOffer.execute({ id: offerId, title: 'Renamed' }, buildCtx(harness.container))
      expect(harness.offer?.title).toBe('Renamed')
    })
  })

  it('settings upsert returns 409 on a stale lock', async () => {
    const settings = new OfferGeneratorSettings()
    Object.assign(settings, { id: randomUUID(), ...scope, templateHtml: '<html></html>', updatedAt: offerUpdatedAt })
    const harness = buildHarness({ settings })
    await expectHttpError(
      Promise.resolve(
        upsertSettings.execute(
          {
            ...scope,
            companyName: 'Acme',
            templateHtml: '<html><body>Template</body></html>',
            defaultLanguage: 'pl',
            defaultCurrency: 'PLN',
            alternateModels: [],
            expectedUpdatedAt: '2026-11-01T00:00:00.000Z',
          },
          buildCtx(harness.container),
        ),
      ),
      409,
    )
    expect(settings.companyName).not.toBe('Acme')
  })

  it('settings upsert creates the row when missing', async () => {
    const harness = buildHarness()
    const result = await upsertSettings.execute(
      {
        ...scope,
        companyName: 'Acme',
        templateHtml: '<html><body>Template</body></html>',
        defaultLanguage: 'en',
        defaultCurrency: 'eur',
        alternateModels: ['google/gemini-3.1-pro-preview'],
      },
      buildCtx(harness.container),
    )
    const row = harness.persisted.find((entity): entity is OfferGeneratorSettings => entity instanceof OfferGeneratorSettings)
    expect(result.created).toBe(true)
    expect(row).toMatchObject({ companyName: 'Acme', defaultLanguage: 'en', defaultCurrency: 'EUR' })
    expect(row?.alternateModels).toEqual(['google/gemini-3.1-pro-preview'])
  })
})

describe('offer_generator serializers', () => {
  it('serializes an offer with the public url and hides encrypted fields outside detail', () => {
    const offer = buildOffer({ prompt: 'Secret prompt', notes: 'Internal', htmlUpdatedAt: offerUpdatedAt, valueAmount: '100.00' })
    const list = serializeOffer(offer, { detail: false, baseUrl: 'https://crm.example.com/' })
    expect(list.publicUrl).toBe('https://crm.example.com/oferta/acme-sp-z-o-o-2026-11-abcdefghijk1')
    expect(list.hasHtml).toBe(true)
    expect(list.valueAmount).toBe('100.00')
    expect(list).not.toHaveProperty('prompt')
    expect(list).not.toHaveProperty('notes')
    const detail = serializeOffer(offer, { detail: true, baseUrl: 'https://crm.example.com' })
    expect(detail.prompt).toBe('Secret prompt')
    expect(detail.notes).toBe('Internal')
    expect(detail.updatedAt).toBe(offerUpdatedAt.toISOString())
  })
})
