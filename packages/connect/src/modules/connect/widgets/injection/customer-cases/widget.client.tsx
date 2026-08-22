"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Connect conversation summary on a Customer detail page.
 *
 * Counts and a timestamp, nothing more. This footer renders for anyone who can
 * open the customer record and holds `connect.customer_match.read`; a subject or
 * a message excerpt here would put conversation content in front of people the
 * Inbox access matrix never granted the Case to.
 *
 * The kind comes from the host's `resourceKind`, not from the record, so the
 * widget stays inert on any other detail page it might be mounted on.
 */

type ContextShape = {
  kind: 'person' | 'company'
  id: string
}

type ConnectContext = {
  openCaseCount: number
  lastCaseAt: string | null
  lastCaseStatus: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(source: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const candidate = source[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

export function resolveCustomerContextTarget(contextValue: unknown): ContextShape | null {
  const context = asRecord(contextValue)
  if (!context) return null
  const resourceKind = readString(context, 'resourceKind', 'resource_kind')
  const kind =
    resourceKind === 'customers.person' ? 'person' : resourceKind === 'customers.company' ? 'company' : null
  if (!kind) return null
  const id = readString(context, 'resourceId', 'resource_id', 'recordId', 'record_id')
  // A create form has no record id yet, and there is nothing to summarise.
  return id ? { kind, id } : null
}

export default function ConnectCustomerCasesWidget({
  context,
}: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>) {
  const t = useT()
  const target = React.useMemo(() => resolveCustomerContextTarget(context), [context])
  const [state, setState] = React.useState<
    { status: 'idle' | 'loading' } | { status: 'ready'; context: ConnectContext } | { status: 'error' }
  >({ status: 'idle' })
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    if (!target) return
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const { ok, result } = await apiCall<{ context?: ConnectContext | null }>(
          `/api/connect/customer-context?kind=${encodeURIComponent(target.kind)}&id=${encodeURIComponent(target.id)}`,
        )
        if (!ok) throw new Error('[internal] connect customer context request failed')
        if (cancelled) return
        setState({
          status: 'ready',
          context: result?.context ?? { openCaseCount: 0, lastCaseAt: null, lastCaseStatus: null },
        })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, reloadToken])

  if (!target) return null

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <SectionHeader title={t('connect.customerContext.title')} />
      {state.status === 'loading' || state.status === 'idle' ? (
        <div role="status" aria-live="polite">
          <LoadingMessage label={t('connect.customerContext.loading')} />
        </div>
      ) : null}
      {state.status === 'error' ? (
        <ErrorMessage
          label={t('connect.customerContext.error')}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => setReloadToken((token) => token + 1)}>
              {t('connect.customerContext.retry')}
            </Button>
          }
        />
      ) : null}
      {state.status === 'ready' ? (
        state.context.openCaseCount === 0 && !state.context.lastCaseAt ? (
          <EmptyState title={t('connect.customerContext.empty')} />
        ) : (
          <dl className="grid grid-cols-2 gap-4 text-sm" aria-live="polite">
            <div>
              <dt className="text-muted-foreground">{t('connect.customerContext.openCases')}</dt>
              <dd className="font-medium">{state.context.openCaseCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('connect.customerContext.lastCaseAt')}</dt>
              <dd className="font-medium">
                {state.context.lastCaseAt
                  ? new Date(state.context.lastCaseAt).toLocaleString()
                  : t('connect.customerContext.never')}
              </dd>
            </div>
          </dl>
        )
      ) : null}
    </section>
  )
}
