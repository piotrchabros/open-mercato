import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { conflict, isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { OfferGeneratorSettings } from '../data/entities'
import { settingsUpsertSchema } from '../data/validators'
import { ENTITY_IDS } from '../lib/constants'

export const SETTINGS_RESOURCE_KIND = 'offer_generator.settings'

export const SETTINGS_COMMAND_IDS = {
  upsert: 'offer_generator.settings.upsert',
} as const

const SETTINGS_SCOPE_CONSTRAINT = 'offer_generator_settings_scope_uq'

export const settingsUpsertCommandSchema = settingsUpsertSchema.extend({
  expectedUpdatedAt: z.union([z.string().min(1), z.date()]).nullable().optional(),
})
export type SettingsUpsertCommandInput = z.input<typeof settingsUpsertCommandSchema>

export type SettingsUpsertResult = {
  settingsId: string
  created: boolean
  updatedAt: string
}

const upsertSettingsCommand: CommandHandler<SettingsUpsertCommandInput, SettingsUpsertResult> = {
  id: SETTINGS_COMMAND_IDS.upsert,
  isUndoable: false,
  async execute(rawInput, ctx) {
    const parsed = settingsUpsertCommandSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const scope = { tenantId: parsed.tenantId, organizationId: parsed.organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const existing = await findOneWithDecryption(em, OfferGeneratorSettings, { ...scope }, undefined, scope)

    if (existing) {
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: SETTINGS_RESOURCE_KIND,
        resourceId: existing.id,
        current: existing.updatedAt,
        expected: parsed.expectedUpdatedAt ?? null,
        request: ctx.request ?? null,
      })
    }

    const now = new Date()
    const settings =
      existing ??
      em.create(OfferGeneratorSettings, {
        ...scope,
        templateHtml: parsed.templateHtml,
      })

    try {
      await runCrudCommandWrite({
        ctx,
        em,
        entityId: ENTITY_IDS.settings,
        action: existing ? 'updated' : 'created',
        scope,
        sideEffect: () => ({
          entity: settings,
          identifiers: { id: settings.id, organizationId: settings.organizationId, tenantId: settings.tenantId },
        }),
        phases: [
          ({ em: writeEm }) => {
            settings.companyName = parsed.companyName
            settings.templateHtml = parsed.templateHtml
            settings.extraInstructions = parsed.extraInstructions ?? null
            settings.defaultLanguage = parsed.defaultLanguage
            settings.defaultCurrency = parsed.defaultCurrency
            settings.defaultModel = parsed.defaultModel ?? null
            settings.alternateModels = [...parsed.alternateModels]
            settings.updatedAt = now
            writeEm.persist(settings)
          },
        ],
      })
    } catch (error) {
      if (!existing && isUniqueViolation(error, SETTINGS_SCOPE_CONSTRAINT)) {
        const { translate } = await resolveTranslations()
        throw conflict(
          translate('offer_generator.errors.settingsConflict', 'Settings were saved by someone else. Reload and try again.'),
        )
      }
      throw error
    }

    return { settingsId: settings.id, created: !existing, updatedAt: settings.updatedAt.toISOString() }
  },
  buildLog: async ({ result, input }) => {
    const { translate } = await resolveTranslations()
    const parsed = settingsUpsertCommandSchema.parse(input)
    return {
      actionLabel: translate('offer_generator.audit.settings.upsert', 'Update offer generator settings'),
      resourceKind: SETTINGS_RESOURCE_KIND,
      resourceId: result.settingsId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      context: { created: result.created },
    }
  },
}

registerCommand(upsertSettingsCommand)

export { upsertSettingsCommand }
