"use client"

import * as React from 'react'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { LookupSelect, type LookupSelectItem } from '@open-mercato/ui/backend/inputs/LookupSelect'
import type { CrudField, CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { Input } from '@open-mercato/ui/primitives/input'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'

/**
 * Shared pieces of the cost-input create and edit forms.
 *
 * The three selectors here all degrade rather than fail. A cost recorder who
 * lacks `staff.view` or whose `currencies` module is disabled still sees a
 * coherent form that explains what is unavailable and refuses to submit the
 * affected cost type, instead of a control that silently posts something the
 * server will reject.
 */

export const COST_INPUT_TYPE_VALUES = ['agent', 'channel', 'ai'] as const
export const COST_INPUT_SOURCE_VALUES = ['manual', 'provider_invoice'] as const

export type CostInputFormValues = {
  id?: string
  periodStart: string
  periodEnd: string
  costType: 'agent' | 'channel' | 'ai'
  userId: string
  channelId: string
  amountMinor: string
  currencyCode: string
  source: 'manual' | 'provider_invoice'
  providerInvoiceRef: string
  providerLineRef: string
  description: string
  updatedAt?: string
} & Record<string, unknown>

type CurrencyOptionResponse = { item?: { code?: unknown } }

export type CurrencyDependencyState =
  | { status: 'loading' }
  | { status: 'ready'; code: string }
  | { status: 'unavailable' }

/**
 * Loads the singleton base-currency code.
 *
 * `unavailable` is a first-class state, not an empty string: the server refuses
 * writes it cannot verify, so the form has to refuse them too rather than let a
 * user fill in a long invoice row and lose it to a 422 on submit.
 */
export function useCostInputCurrency(): CurrencyDependencyState {
  const [state, setState] = React.useState<CurrencyDependencyState>({ status: 'loading' })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const call = await apiCall<CurrencyOptionResponse>(
        '/api/connect_analytics/cost-input-options/currency',
        undefined,
        { fallback: {} },
      )
      if (cancelled) return
      const code = call.ok && typeof call.result?.item?.code === 'string' ? call.result.item.code : null
      setState(code ? { status: 'ready', code } : { status: 'unavailable' })
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

type PeerLookupState = {
  items: LookupSelectItem[]
  authorized: boolean
  loading: boolean
}

function usePeerLookup(
  url: string,
  mapItem: (raw: Record<string, unknown>) => LookupSelectItem | null,
): PeerLookupState {
  const [state, setState] = React.useState<PeerLookupState>({ items: [], authorized: true, loading: true })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const call = await apiCall<{ items?: unknown[] }>(url, undefined, { fallback: { items: [] } })
      if (cancelled) return
      if (!call.ok) {
        // 401/403 and a transport failure are the same thing to this form: the
        // peer directory cannot be offered, so the dimension is disabled.
        setState({ items: [], authorized: false, loading: false })
        return
      }
      const raw = Array.isArray(call.result?.items) ? call.result.items : []
      const items = raw
        .map((entry) => (entry && typeof entry === 'object' ? mapItem(entry as Record<string, unknown>) : null))
        .filter((entry): entry is LookupSelectItem => entry !== null)
      setState({ items, authorized: true, loading: false })
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [mapItem, url])

  return state
}

function readText(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

const mapTeamMember = (raw: Record<string, unknown>): LookupSelectItem | null => {
  // The cost row stores the *user* id, not the team-member id: a team member
  // can be re-created, and an agent cost must stay attributable to the person.
  const userId = readText(raw, 'userId', 'user_id')
  const title = readText(raw, 'displayName', 'display_name') ?? userId
  return userId && title ? { id: userId, title } : null
}

const mapChannel = (raw: Record<string, unknown>): LookupSelectItem | null => {
  const id = readText(raw, 'id')
  const title = readText(raw, 'displayName', 'display_name') ?? id
  const subtitle = readText(raw, 'channelType', 'channel_type')
  return id && title ? { id, title, subtitle } : null
}

export function useAgentOptions(): PeerLookupState {
  return usePeerLookup('/api/staff/team-members?pageSize=100&isActive=true', mapTeamMember)
}

export function useChannelOptions(): PeerLookupState {
  return usePeerLookup('/api/communication_channels/channels?pageSize=100&isActive=true', mapChannel)
}

type PeerSelectProps = {
  id: string
  value: string | null
  onChange: (next: string | null) => void
  lookup: PeerLookupState
  translate: TranslateFn
  placeholder: string
  unavailableLabel: string
  disabled?: boolean
}

/**
 * A stored id whose peer record is gone or inaccessible renders as an explicit
 * "record unavailable" entry rather than disappearing — the cost row is still
 * valid, and silently blanking its dimension would look like a data loss.
 */
export function PeerSelectField({
  value,
  onChange,
  lookup,
  translate,
  placeholder,
  unavailableLabel,
  disabled,
}: PeerSelectProps) {
  const options = React.useMemo<LookupSelectItem[]>(() => {
    if (!value) return lookup.items
    if (lookup.items.some((item) => item.id === value)) return lookup.items
    return [{ id: value, title: unavailableLabel, subtitle: value }, ...lookup.items]
  }, [lookup.items, unavailableLabel, value])

  if (!lookup.authorized) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('connect_analytics.costInputs.form.peerUnauthorized')}
      </p>
    )
  }

  return (
    <LookupSelect
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      loading={lookup.loading}
      placeholder={placeholder}
      searchPlaceholder={placeholder}
      emptyLabel={translate('connect_analytics.costInputs.form.peerEmpty')}
      loadingLabel={translate('connect_analytics.common.loading')}
      clearLabel={translate('connect_analytics.costInputs.form.clear')}
      selectLabel={translate('connect_analytics.costInputs.form.select')}
    />
  )
}

export function CurrencyField({
  id,
  currency,
  translate,
}: {
  id: string
  currency: CurrencyDependencyState
  translate: TranslateFn
}) {
  if (currency.status === 'loading') {
    return <p className="text-sm text-muted-foreground">{translate('connect_analytics.common.loading')}</p>
  }
  if (currency.status === 'unavailable') {
    return (
      <p className="text-sm text-status-danger-fg">
        {translate('connect_analytics.costInputs.form.currencyUnavailable')}
      </p>
    )
  }
  return <Input id={id} value={currency.code} readOnly aria-readonly="true" />
}

/**
 * Reads a `datetime-local` value as UTC.
 *
 * The control emits a zone-less `YYYY-MM-DDTHH:mm`, which `new Date()` would
 * interpret in the browser's zone — silently shifting every stored period
 * boundary by the operator's offset. Cost periods are half-open UTC by
 * definition, so the wall-clock the operator typed IS the UTC instant.
 */
function parseUtcWallClock(value: string): Date {
  if (!value) return new Date(Number.NaN)
  const zoneless = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
  return new Date(zoneless ? `${value}${value.length === 16 ? ':00' : ''}Z` : value)
}

/**
 * Local, pre-flight validation.
 *
 * Deliberately a mirror of the server rules rather than a substitute for them:
 * the server re-validates everything here. It exists so a mistyped amount is
 * caught next to the field instead of arriving as a whole-form 422.
 */
export function validateCostInputValues(
  values: CostInputFormValues,
  currency: CurrencyDependencyState,
  translate: TranslateFn,
): {
  periodStart: string
  periodEnd: string
  costType: 'agent' | 'channel' | 'ai'
  userId: string | null
  channelId: string | null
  amountMinor: string
  currencyCode: string
  source: 'manual' | 'provider_invoice'
  providerInvoiceRef: string | null
  providerLineRef: string | null
  description: string | null
} {
  if (currency.status !== 'ready') {
    throw createCrudFormError(translate('connect_analytics.costInputs.form.currencyUnavailable'))
  }

  const periodStart = String(values.periodStart ?? '').trim()
  const periodEnd = String(values.periodEnd ?? '').trim()
  const start = parseUtcWallClock(periodStart)
  const end = parseUtcWallClock(periodEnd)
  if (!periodStart || Number.isNaN(start.getTime())) {
    const message = translate('connect_analytics.errors.periodInvalid')
    throw createCrudFormError(message, { periodStart: message })
  }
  if (!periodEnd || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    const message = translate('connect_analytics.errors.periodInvalid')
    throw createCrudFormError(message, { periodEnd: message })
  }

  const amountMinor = String(values.amountMinor ?? '').trim()
  if (!/^(0|[1-9][0-9]{0,18})$/.test(amountMinor)) {
    const message = translate('connect_analytics.errors.amountMinorInvalid')
    throw createCrudFormError(message, { amountMinor: message })
  }

  const costType = values.costType
  const userId = costType === 'agent' ? (String(values.userId ?? '').trim() || null) : null
  const channelId = costType === 'channel' ? (String(values.channelId ?? '').trim() || null) : null
  if (costType === 'agent' && !userId) {
    const message = translate('connect_analytics.errors.dimensionInvalid')
    throw createCrudFormError(message, { userId: message })
  }
  if (costType === 'channel' && !channelId) {
    const message = translate('connect_analytics.errors.dimensionInvalid')
    throw createCrudFormError(message, { channelId: message })
  }

  const source = values.source
  const providerInvoiceRef = source === 'provider_invoice'
    ? (String(values.providerInvoiceRef ?? '').trim() || null)
    : null
  const providerLineRef = source === 'provider_invoice'
    ? (String(values.providerLineRef ?? '').trim() || null)
    : null
  if (source === 'provider_invoice' && (!providerInvoiceRef || !providerLineRef)) {
    const message = translate('connect_analytics.errors.provenanceInvalid')
    throw createCrudFormError(message, {
      providerInvoiceRef: providerInvoiceRef ? '' : message,
      providerLineRef: providerLineRef ? '' : message,
    })
  }

  const description = String(values.description ?? '').trim() || null

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    costType,
    userId,
    channelId,
    amountMinor,
    currencyCode: currency.code,
    source,
    providerInvoiceRef,
    providerLineRef,
    description,
  }
}

type ServerErrorLike = { code?: unknown; error?: unknown }

/**
 * Turns the route's published `code` vocabulary into a localized message. Falls
 * through untouched when the error is not one of ours, so an optimistic-lock
 * 409 still reaches `surfaceRecordConflict`.
 */
export function translateCostInputError(err: unknown, translate: TranslateFn): unknown {
  if (!err || typeof err !== 'object') return err
  const code = (err as ServerErrorLike).code
  if (typeof code !== 'string') return err
  const key = `connect_analytics.errors.${code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`
  const message = translate(key)
  if (!message || message === key) return err
  return createCrudFormError(message)
}

/**
 * The field and group definitions shared by the create and edit forms.
 *
 * Kept in one place because the two forms must present the same conditional
 * rules — a divergence would let one of them submit a shape the other rejects
 * and the server refuses.
 */
export function useCostInputFormLayout(translate: TranslateFn): {
  fields: CrudField[]
  groups: CrudFormGroup[]
  currency: CurrencyDependencyState
} {
  const currency = useCostInputCurrency()
  const agents = useAgentOptions()
  const channels = useChannelOptions()

  const fields = React.useMemo<CrudField[]>(() => [
    {
      id: 'periodStart',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.periodStart'),
      description: translate('connect_analytics.costInputs.form.periodHelp'),
      type: 'datetime-local',
      required: true,
    },
    {
      id: 'periodEnd',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.periodEnd'),
      type: 'datetime-local',
      required: true,
    },
    {
      id: 'costType',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.costType'),
      type: 'select',
      required: true,
      options: COST_INPUT_TYPE_VALUES.map((value) => ({
        value,
        label: translate(`connect_analytics.costInputs.type.${value}`),
      })),
    },
    {
      id: 'userId',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.agent'),
      type: 'custom',
      visibleWhen: { field: 'costType', equals: 'agent' },
      component: ({ id, value, setValue, disabled }) => (
        <PeerSelectField
          id={id}
          value={typeof value === 'string' && value.length ? value : null}
          onChange={(next) => setValue(next ?? '')}
          lookup={agents}
          translate={translate}
          disabled={disabled}
          placeholder={translate('connect_analytics.costInputs.form.agentPlaceholder')}
          unavailableLabel={translate('connect_analytics.common.recordUnavailable')}
        />
      ),
    },
    {
      id: 'channelId',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.channel'),
      type: 'custom',
      visibleWhen: { field: 'costType', equals: 'channel' },
      component: ({ id, value, setValue, disabled }) => (
        <PeerSelectField
          id={id}
          value={typeof value === 'string' && value.length ? value : null}
          onChange={(next) => setValue(next ?? '')}
          lookup={channels}
          translate={translate}
          disabled={disabled}
          placeholder={translate('connect_analytics.costInputs.form.channelPlaceholder')}
          unavailableLabel={translate('connect_analytics.common.recordUnavailable')}
        />
      ),
    },
    {
      id: 'amountMinor',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.amountMinor'),
      description: translate('connect_analytics.costInputs.form.amountMinorHelp'),
      type: 'text',
      required: true,
    },
    {
      id: 'currencyCode',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.currency'),
      type: 'custom',
      component: ({ id }) => <CurrencyField id={id} currency={currency} translate={translate} />,
    },
    {
      id: 'source',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.source'),
      type: 'select',
      required: true,
      options: COST_INPUT_SOURCE_VALUES.map((value) => ({
        value,
        label: translate(`connect_analytics.costInputs.source.${value}`),
      })),
    },
    {
      id: 'providerInvoiceRef',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.providerInvoiceRef'),
      type: 'text',
      maxLength: 255,
      visibleWhen: { field: 'source', equals: 'provider_invoice' },
    },
    {
      id: 'providerLineRef',
      layout: 'half',
      label: translate('connect_analytics.costInputs.form.providerLineRef'),
      description: translate('connect_analytics.costInputs.form.providerLineRefHelp'),
      type: 'text',
      maxLength: 255,
      visibleWhen: { field: 'source', equals: 'provider_invoice' },
    },
    {
      id: 'description',
      label: translate('connect_analytics.costInputs.form.description'),
      description: translate('connect_analytics.costInputs.form.descriptionHelp'),
      type: 'textarea',
      rows: 4,
      maxLength: 500,
      showCount: true,
    },
  ], [agents, channels, currency, translate])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    {
      id: 'period',
      title: translate('connect_analytics.costInputs.form.groups.period'),
      column: 1,
      fields: ['periodStart', 'periodEnd', 'costType', 'userId', 'channelId'],
    },
    {
      id: 'amount',
      title: translate('connect_analytics.costInputs.form.groups.amount'),
      column: 2,
      fields: ['amountMinor', 'currencyCode'],
    },
    {
      id: 'provenance',
      title: translate('connect_analytics.costInputs.form.groups.provenance'),
      column: 2,
      fields: ['source', 'providerInvoiceRef', 'providerLineRef', 'description'],
    },
  ], [translate])

  return { fields, groups, currency }
}
