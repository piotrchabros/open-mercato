import type {
  SearchBuildContext,
  SearchIndexSource,
  SearchModuleConfig,
  SearchResultPresenter,
} from '@open-mercato/shared/modules/search'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

/**
 * Cost inputs are searchable by what they *are*, never by what they cost.
 *
 * The indexed text carries cost type, currency, source and the UTC period
 * labels — enough for an operator to find "the March channel invoice rows" from
 * the command palette. Amount, description, provider identities, user/channel
 * ids and actor ids are excluded: global search results are rendered in
 * surfaces with a wider audience than the cost list itself, and a fulltext or
 * vector index is the wrong place for financial and personal data.
 *
 * The already-authorized DataTable reads amounts through the CRUD list route,
 * which enforces `cost_inputs.view` per request; it does not read them here.
 */

function assertTenantContext(ctx: SearchBuildContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.length === 0) {
    throw new Error('[internal] [search.connect_analytics] Missing tenantId in search build context')
  }
}

function utcDayLabel(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value !== 'string' || value.length === 0) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

async function buildPresenter(record: Record<string, unknown>): Promise<SearchResultPresenter> {
  const { t } = await resolveTranslations()
  const costType = readString(record, 'cost_type')
  const currency = readString(record, 'currency_code')
  const from = utcDayLabel(record.period_start)
  const to = utcDayLabel(record.period_end)
  return {
    title: t(
      `connect_analytics.costInputs.type.${costType || 'ai'}`,
      costType || 'Cost input',
    ),
    subtitle: t(
      'connect_analytics.costInputs.search.subtitle',
      '{{from}} → {{to}} · {{currency}}',
      { from, to, currency },
    ),
    icon: 'receipt',
  }
}

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'connect_analytics:cost_input',
      aclFeatures: ['connect_analytics.cost_inputs.view'],
      enabled: true,
      priority: 4,
      fieldPolicy: {
        searchable: ['cost_type', 'currency_code', 'source'],
        excluded: [
          'amount_minor',
          'description',
          'provider_invoice_ref',
          'provider_line_ref',
          'user_id',
          'channel_id',
          'created_by_user_id',
          'updated_by_user_id',
        ],
      },
      buildSource: async (ctx: SearchBuildContext): Promise<SearchIndexSource | null> => {
        assertTenantContext(ctx)
        const record = ctx.record
        const costType = readString(record, 'cost_type')
        if (!costType) return null
        const currency = readString(record, 'currency_code')
        const source = readString(record, 'source')
        const from = utcDayLabel(record.period_start)
        const to = utcDayLabel(record.period_end)

        return {
          text: [costType, currency, source, from, to].filter(Boolean).join(' '),
          fields: {
            cost_type: costType,
            currency_code: currency,
            source,
            period_start: from,
            period_end: to,
          },
          presenter: await buildPresenter(record),
          checksumSource: { costType, currency, source, from, to },
        }
      },
      formatResult: async (ctx: SearchBuildContext): Promise<SearchResultPresenter | null> =>
        buildPresenter(ctx.record),
      resolveUrl: async (ctx: SearchBuildContext): Promise<string | null> => {
        const id = ctx.record.id
        if (!id) return null
        return `/backend/connect/analytics/cost-inputs/${encodeURIComponent(String(id))}`
      },
    },
  ],
}

export const config = searchConfig
export default searchConfig
