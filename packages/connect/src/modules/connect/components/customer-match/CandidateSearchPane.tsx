'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CandidateKind, CandidateRow } from './types'

/**
 * Candidate search for a manual match.
 *
 * It queries the AUTHORIZED customers list APIs rather than a Connect-owned
 * index, so an agent can only find customers they were already allowed to see,
 * and the results are scoped by the same rules as the Customers screens.
 *
 * Results carry a name and a masked contact hint only. The selected UUID is
 * revalidated server-side by the link command, so nothing shown here is
 * authorization — it is evidence for a human decision.
 */

const DEBOUNCE_MS = 300
const PAGE_SIZE = 25

type CustomerListResponse = {
  items?: Array<Record<string, unknown>>
  total?: number
}

function readText(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/**
 * Show enough of a contact to recognise the right record and no more. A full
 * address on a search screen is a bulk-export surface.
 */
function maskContact(value: string | null): string | null {
  if (!value) return null
  const at = value.indexOf('@')
  if (at > 0) {
    const local = value.slice(0, at)
    const head = local.slice(0, 1)
    return `${head}${'…'}${local.slice(-1)}${value.slice(at)}`
  }
  return value.length <= 4 ? `${'…'}${value}` : `${'…'}${value.slice(-4)}`
}

function toCandidate(kind: CandidateKind, record: Record<string, unknown>): CandidateRow | null {
  const id = readText(record, 'id')
  if (!id) return null
  const label =
    kind === 'person'
      ? readText(record, 'displayName', 'display_name', 'name', 'fullName', 'full_name') ??
        [readText(record, 'firstName', 'first_name'), readText(record, 'lastName', 'last_name')]
          .filter(Boolean)
          .join(' ')
      : readText(record, 'displayName', 'display_name', 'name', 'legalName', 'legal_name')
  return {
    id,
    label: label && label.trim() ? label : id,
    contactHint: maskContact(readText(record, 'email', 'primaryEmail', 'primary_email', 'phone')),
  }
}

type Props = {
  kind: CandidateKind
  onKindChange: (kind: CandidateKind) => void
  selectedId: string | null
  onSelect: (candidate: CandidateRow | null) => void
  disabled: boolean
}

export function CandidateSearchPane({ kind, onKindChange, selectedId, onSelect, disabled }: Props) {
  const t = useT()
  const [term, setTerm] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [rows, setRows] = React.useState<CandidateRow[]>([])
  const [total, setTotal] = React.useState(0)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [term])

  React.useEffect(() => {
    let cancelled = false
    if (!debounced) {
      setRows([])
      setTotal(0)
      setError(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    void (async () => {
      const path = kind === 'person' ? 'people' : 'companies'
      const response = await apiCall<CustomerListResponse>(
        `/api/customers/${path}?search=${encodeURIComponent(debounced)}&pageSize=${PAGE_SIZE}`,
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok) {
        setError(t('connect.customerMatch.errors.search', 'Could not search customers'))
        setRows([])
        setTotal(0)
      } else {
        const items = response.result?.items ?? []
        setRows(items.map((item) => toCandidate(kind, item)).filter((row): row is CandidateRow => row !== null))
        setTotal(typeof response.result?.total === 'number' ? response.result.total : items.length)
        setError(null)
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [debounced, kind, t])

  const kinds: Array<{ id: CandidateKind; label: string }> = [
    { id: 'person', label: t('connect.customerMatch.kind.person', 'People') },
    { id: 'company', label: t('connect.customerMatch.kind.company', 'Companies') },
  ]

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex gap-1" role="tablist" aria-label={t('connect.customerMatch.kind.aria', 'Customer type')}>
        {kinds.map((entry) => (
          <Button
            key={entry.id}
            role="tab"
            aria-selected={kind === entry.id}
            variant={kind === entry.id ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => {
              onKindChange(entry.id)
              // The selection belongs to the previous tab's result set; keeping
              // it would let a confirm submit a person id as a company.
              onSelect(null)
            }}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <Input
        value={term}
        disabled={disabled}
        onChange={(event) => setTerm(event.target.value)}
        placeholder={t('connect.customerMatch.search.placeholder', 'Search by name or contact')}
        aria-label={t('connect.customerMatch.search.aria', 'Search customers')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {isLoading ? (
          <LoadingMessage label={t('connect.customerMatch.search.loading', 'Searching...')} />
        ) : error ? (
          <ErrorMessage label={error} />
        ) : !debounced ? (
          <EmptyState title={t('connect.customerMatch.search.prompt', 'Type to search for a customer')} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('connect.customerMatch.search.empty', 'No matching customers')} />
        ) : (
          <>
            <p className="px-1 pb-2 text-xs text-muted-foreground">
              {t('connect.customerMatch.search.count', 'Showing {shown} of {total} matches')
                .replace('{shown}', String(rows.length))
                .replace('{total}', String(total))}
            </p>
            <ul role="listbox" aria-label={t('connect.customerMatch.search.results', 'Search results')}>
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedId === row.id}
                    disabled={disabled}
                    onClick={() => onSelect(row)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-md border p-2 text-left text-sm ${
                      selectedId === row.id ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent'
                    }`}
                  >
                    <span className="font-medium">{row.label}</span>
                    {row.contactHint ? (
                      <span className="text-xs text-muted-foreground">{row.contactHint}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
