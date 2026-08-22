'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ExceptionsResponse, ExceptionType } from './types'

/**
 * The rows behind the exception counters.
 *
 * A metrics screen that says "3 unreconciled" and stops is not operable, so
 * this resolves each counter to the identifiers an operator can act on — and to
 * nothing more. No handle, no subject, no body: a reporting surface must not
 * become the easiest place in the product to read message content.
 *
 * Remediation links point at the Foundation-owned receipt routes, which enforce
 * their own guards. Nothing here mutates.
 */

const TYPES: ExceptionType[] = ['unreconciled_inbound', 'dead_lettered', 'unknown_send', 'projection_failed']

/** The identifier columns worth showing, per exception type. */
const COLUMNS: Record<ExceptionType, string[]> = {
  unreconciled_inbound: ['receiptId', 'channelId', 'claimCohortUtcDate', 'attempts', 'leaseExpiresAt'],
  dead_lettered: ['receiptId', 'channelId', 'claimCohortUtcDate', 'terminalReason', 'attempts'],
  unknown_send: ['attemptId', 'caseId', 'ageSeconds', 'lastCheckedAt'],
  projection_failed: ['projectionKey', 'caseId', 'lastError', 'attempts'],
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return String(value)
}

export function ExceptionsPane() {
  const t = useT()
  const [type, setType] = React.useState<ExceptionType>('unreconciled_inbound')
  const [data, setData] = React.useState<ExceptionsResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void (async () => {
      const response = await apiCall<ExceptionsResponse>(
        `/api/connect/metrics/exceptions?type=${encodeURIComponent(type)}&pageSize=50`,
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok || !response.result) {
        setError(t('connect.metrics.errors.exceptions', 'Could not load exceptions'))
      } else {
        setData(response.result)
        setError(null)
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [type, reloadToken, t])

  const columns = COLUMNS[type]

  return (
    <section aria-label={t('connect.metrics.exceptions.aria', 'Operational exceptions')}>
      <SectionHeader title={t('connect.metrics.exceptions.title', 'Exceptions')} />
      <div className="mb-2 flex flex-wrap gap-1" role="tablist">
        {TYPES.map((entry) => (
          <Button
            key={entry}
            role="tab"
            aria-selected={type === entry}
            variant={type === entry ? 'default' : 'outline'}
            onClick={() => setType(entry)}
          >
            {t(`connect.metrics.exceptions.types.${entry}`, entry)}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <LoadingMessage label={t('connect.metrics.exceptions.loading', 'Loading exceptions...')} />
      ) : error ? (
        <ErrorMessage
          label={error}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => setReloadToken((token) => token + 1)}>
              {t('connect.metrics.actions.retry', 'Retry')}
            </Button>
          }
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState title={t('connect.metrics.exceptions.empty', 'Nothing needs attention here')} />
      ) : (
        <div className="overflow-x-auto" aria-live="polite">
          <p className="p-2 text-xs text-muted-foreground">
            {t('connect.metrics.exceptions.count', 'Showing {shown} of {total}')
              .replace('{shown}', String(data.items.length))
              .replace('{total}', String(data.total))}
          </p>
          <table className="w-full text-sm">
            <caption className="sr-only">
              {t('connect.metrics.exceptions.caption', 'Connect operational exceptions needing attention')}
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                {columns.map((column) => (
                  <th key={column} scope="col" className="p-2">
                    {t(`connect.metrics.exceptions.columns.${column}`, column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, index) => (
                <tr key={`${renderCell(item[columns[0]!])}-${index}`} className="border-b border-border">
                  {columns.map((column) => (
                    <td key={column} className="p-2">
                      {renderCell(item[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
