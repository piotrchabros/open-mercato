'use client'

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { ConnectSlaInboxContext } from './widget'

type ClockState = 'open' | 'met' | 'breached' | 'unknown' | 'merged' | 'superseded'

type ClockSummary = {
  generation: number
  responseDueAt: string
  resolutionDueAt: string
  responseState: ClockState
  resolutionState: ClockState
}

type ClockResponse = { items?: ClockSummary[] }

const STATE_VARIANT: Record<ClockState, StatusBadgeVariant> = {
  open: 'info',
  met: 'success',
  breached: 'error',
  unknown: 'neutral',
  merged: 'neutral',
  superseded: 'neutral',
}

export function buildInboxClockUrl(caseId: string): string {
  return `/api/connect-sla/clocks?caseId=${encodeURIComponent(caseId)}`
}

export default function ConnectSlaInboxClockWidget({
  context,
}: InjectionWidgetComponentProps<ConnectSlaInboxContext, Record<string, unknown>>) {
  const t = useT()
  const caseId = typeof context?.caseId === 'string' && context.caseId.trim() ? context.caseId : null
  const [state, setState] = React.useState<
    | { status: 'loading' }
    | { status: 'ready'; clock: ClockSummary | null }
    | { status: 'error' }
  >({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    if (!caseId) return
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      try {
        const response = await apiCall<ClockResponse>(buildInboxClockUrl(caseId))
        if (!response.ok) throw new Error('[internal] connect SLA clock request failed')
        if (!cancelled) setState({ status: 'ready', clock: response.result?.items?.[0] ?? null })
      } catch {
        if (!cancelled) setState({ status: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [caseId, reloadToken])

  if (!caseId) return null

  return (
    <section className="border-b border-border bg-card p-4" aria-label={t('connect_sla.inbox.title')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('connect_sla.inbox.title')}</h3>
      </div>
      {state.status === 'loading' ? (
        <LoadingMessage label={t('connect_sla.inbox.loading')} />
      ) : null}
      {state.status === 'error' ? (
        <ErrorMessage
          label={t('connect_sla.inbox.error')}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => setReloadToken((token) => token + 1)}>
              {t('connect_sla.inbox.retry')}
            </Button>
          }
        />
      ) : null}
      {state.status === 'ready' && !state.clock ? (
        <p className="text-sm text-muted-foreground">{t('connect_sla.inbox.empty')}</p>
      ) : null}
      {state.status === 'ready' && state.clock ? (
        <dl className="grid grid-cols-2 gap-3 text-sm" aria-live="polite">
          <div>
            <dt className="mb-1 text-muted-foreground">{t('connect_sla.inbox.response')}</dt>
            <dd className="space-y-1">
              <StatusBadge variant={STATE_VARIANT[state.clock.responseState]}>
                {t(`connect_sla.state.${state.clock.responseState}`)}
              </StatusBadge>
              <div>{new Date(state.clock.responseDueAt).toLocaleString()}</div>
            </dd>
          </div>
          <div>
            <dt className="mb-1 text-muted-foreground">{t('connect_sla.inbox.resolution')}</dt>
            <dd className="space-y-1">
              <StatusBadge variant={STATE_VARIANT[state.clock.resolutionState]}>
                {t(`connect_sla.state.${state.clock.resolutionState}`)}
              </StatusBadge>
              <div>{new Date(state.clock.resolutionDueAt).toLocaleString()}</div>
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  )
}
