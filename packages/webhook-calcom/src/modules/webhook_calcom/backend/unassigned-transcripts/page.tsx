"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions, type RowActionItem } from '@open-mercato/ui/backend/RowActions'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { apiCall, apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { groupBulkDeleteFailures, runBulkDelete } from '@open-mercato/ui/backend/utils/bulkDelete'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { AssignTranscriptDialog } from '../../components/AssignTranscriptDialog'
import { useTranscriptInboxAccess } from '../../components/useTranscriptInboxAccess'
import {
  UNASSIGNED_TRANSCRIPTS_API_PATH,
  UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
  buildPersonHref,
  buildTranscriptDetailHref,
  formatParticipant,
  formatTranscriptDateTime,
  transcriptStatusVariant,
  translateTranscriptReason,
  translateTranscriptSource,
  translateTranscriptStatus,
  type UnassignedTranscriptRow,
} from '../../components/transcriptInbox'

type ListResponse = {
  items: UnassignedTranscriptRow[]
  total: number
  page: number
  totalPages: number
  totalIsCapped?: boolean
}

type DismissMutationContext = {
  formId: string
  resourceKind: string
  resourceId?: string
  retryLastMutation: () => Promise<boolean>
}

const PAGE_SIZE = 20
const VISIBLE_PARTICIPANTS = 2
const DEFAULT_FILTERS: FilterValues = { status: 'pending' }

export default function UnassignedTranscriptsPage() {
  const t = useT()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const access = useTranscriptInboxAccess()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<UnassignedTranscriptRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [totalIsCapped, setTotalIsCapped] = React.useState(false)
  const [filterValues, setFilterValues] = React.useState<FilterValues>(DEFAULT_FILTERS)
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [assignTarget, setAssignTarget] = React.useState<UnassignedTranscriptRow | null>(null)

  const status = filterValues.status === 'resolved' ? 'resolved' : 'pending'

  const singleContextId = 'webhook_calcom-unassigned-transcripts:dismiss'
  const { runMutation: runSingleMutation, retryLastMutation: retrySingleMutation } =
    useGuardedMutation<DismissMutationContext>({
      contextId: singleContextId,
      blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
    })
  const bulkContextId = 'webhook_calcom-unassigned-transcripts:bulk-dismiss'
  const { runMutation: runBulkMutation, retryLastMutation: retryBulkMutation } =
    useGuardedMutation<DismissMutationContext>({
      contextId: bulkContextId,
      blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
    })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), status })
        const fallback: ListResponse = { items: [], total: 0, page, totalPages: 1 }
        const call = await apiCall<ListResponse>(`${UNASSIGNED_TRANSCRIPTS_API_PATH}?${params.toString()}`, undefined, {
          fallback,
        })
        if (cancelled) return
        if (!call.ok) {
          const errorPayload = call.result as { error?: string } | undefined
          setLoadError(
            typeof errorPayload?.error === 'string'
              ? errorPayload.error
              : t('webhook_calcom.inbox.list.loadError', 'Failed to load transcripts'),
          )
          return
        }
        const payload = call.result ?? fallback
        setLoadError(null)
        setRows(Array.isArray(payload.items) ? payload.items : [])
        setTotal(payload.total || 0)
        setTotalPages(payload.totalPages || 1)
        setTotalIsCapped(payload.totalIsCapped === true)
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error && error.message
              ? error.message
              : t('webhook_calcom.inbox.list.loadError', 'Failed to load transcripts'),
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [page, status, reloadToken, scopeVersion, t])

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  const dismissRequest = React.useCallback(
    (row: UnassignedTranscriptRow) =>
      withScopedApiRequestHeaders(buildOptimisticLockHeader(row.updatedAt), () =>
        apiCallOrThrow(
          `${UNASSIGNED_TRANSCRIPTS_API_PATH}?id=${encodeURIComponent(row.id)}`,
          { method: 'DELETE' },
          { errorMessage: t('webhook_calcom.inbox.dismiss.error', 'Failed to dismiss the transcript') },
        ),
      ),
    [t],
  )

  const handleDismiss = React.useCallback(
    async (row: UnassignedTranscriptRow) => {
      const confirmed = await confirm({
        title: t('webhook_calcom.inbox.dismiss.confirmTitle', 'Dismiss this transcript?'),
        text: t(
          'webhook_calcom.inbox.dismiss.confirmDescription',
          'The transcript is removed from the inbox and is not attached to any person.',
        ),
        confirmText: t('webhook_calcom.inbox.actions.dismiss', 'Dismiss'),
        variant: 'destructive',
      })
      if (!confirmed) return
      try {
        await runSingleMutation({
          operation: () => dismissRequest(row),
          context: {
            formId: singleContextId,
            resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
            resourceId: row.id,
            retryLastMutation: retrySingleMutation,
          },
          mutationPayload: { id: row.id },
        })
        flash(t('webhook_calcom.inbox.dismiss.success', 'Transcript dismissed'), 'success')
        reload()
      } catch (err) {
        if (surfaceRecordConflict(err, t)) return
        const message =
          err instanceof Error && err.message
            ? err.message
            : t('webhook_calcom.inbox.dismiss.error', 'Failed to dismiss the transcript')
        flash(message, 'error')
      }
    },
    [confirm, dismissRequest, reload, retrySingleMutation, runSingleMutation, t],
  )

  const handleBulkDismiss = React.useCallback(
    async (selectedRows: UnassignedTranscriptRow[]) => {
      const confirmed = await confirm({
        title: t('webhook_calcom.inbox.bulkDismiss.confirmTitle', 'Dismiss {count} transcripts?', {
          count: selectedRows.length,
        }),
        text: t(
          'webhook_calcom.inbox.dismiss.confirmDescription',
          'The transcript is removed from the inbox and is not attached to any person.',
        ),
        confirmText: t('webhook_calcom.inbox.actions.dismiss', 'Dismiss'),
        variant: 'destructive',
      })
      if (!confirmed) return false

      const { succeeded, failures } = await runBulkMutation({
        operation: () =>
          runBulkDelete(selectedRows, async (row) => {
            await dismissRequest(row)
          }, {
            fallbackErrorMessage: t('webhook_calcom.inbox.dismiss.error', 'Failed to dismiss the transcript'),
            logTag: 'webhook_calcom.unassigned_transcripts.list',
            progress: {
              jobType: 'webhook_calcom.unassigned_transcripts.bulk_dismiss',
              name: t('webhook_calcom.inbox.bulkDismiss.progressName', 'Dismiss selected transcripts'),
              meta: { source: 'webhook_calcom.unassigned_transcripts.list' },
            },
          }),
        context: {
          formId: bulkContextId,
          resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
          retryLastMutation: retryBulkMutation,
        },
      })

      if (succeeded.length > 0) {
        reload()
        if (failures.length === 0) {
          flash(
            t('webhook_calcom.inbox.bulkDismiss.success', '{count} transcripts dismissed', { count: succeeded.length }),
            'success',
          )
        } else {
          flash(
            t('webhook_calcom.inbox.bulkDismiss.partial', '{dismissed} of {total} transcripts dismissed; {failed} failed', {
              dismissed: succeeded.length,
              total: selectedRows.length,
              failed: failures.length,
            }),
            'warning',
          )
        }
      }

      for (const group of groupBulkDeleteFailures(failures)) {
        flash(
          group.count === 1
            ? group.sampleMessage
            : t('webhook_calcom.inbox.bulkDismiss.failedGroup', '{count} transcripts could not be dismissed: {message}', {
                count: group.count,
                message: group.sampleMessage,
              }),
          'error',
        )
      }

      return succeeded.length > 0
    },
    [confirm, dismissRequest, reload, retryBulkMutation, runBulkMutation, t],
  )

  const filters = React.useMemo<FilterDef[]>(
    () => [
      {
        id: 'status',
        label: t('webhook_calcom.inbox.filters.status', 'Status'),
        type: 'select',
        options: [
          { value: 'pending', label: t('webhook_calcom.inbox.status.pending', 'Pending') },
          { value: 'resolved', label: t('webhook_calcom.inbox.status.resolved', 'Resolved') },
        ],
      },
    ],
    [t],
  )

  const columns = React.useMemo<ColumnDef<UnassignedTranscriptRow>[]>(() => {
    const noValue = <span className="text-muted-foreground">—</span>
    return [
      {
        accessorKey: 'meetingStartedAt',
        header: t('webhook_calcom.inbox.columns.meetingDate', 'Meeting date'),
        cell: ({ row }) => formatTranscriptDateTime(row.original.meetingStartedAt) ?? noValue,
      },
      {
        accessorKey: 'title',
        header: t('webhook_calcom.inbox.columns.title', 'Title'),
        cell: ({ row }) => (
          <Link href={buildTranscriptDetailHref(row.original.id)} className="font-medium text-primary hover:underline">
            {row.original.title || t('webhook_calcom.inbox.untitled', 'Untitled meeting')}
          </Link>
        ),
      },
      {
        accessorKey: 'source',
        header: t('webhook_calcom.inbox.columns.source', 'Source'),
        cell: ({ row }) => translateTranscriptSource(t, row.original.source),
      },
      {
        accessorKey: 'participants',
        header: t('webhook_calcom.inbox.columns.participants', 'Participants'),
        cell: ({ row }) => {
          const participants = row.original.participants
          if (participants.length === 0) return noValue
          const visible = participants.slice(0, VISIBLE_PARTICIPANTS).map(formatParticipant).join(', ')
          const hidden = participants.length - VISIBLE_PARTICIPANTS
          return (
            <span className="text-sm" title={participants.map(formatParticipant).join(', ')}>
              {hidden > 0
                ? t('webhook_calcom.inbox.participantsMore', '{list} +{count}', { list: visible, count: hidden })
                : visible}
            </span>
          )
        },
        meta: { truncate: true },
      },
      {
        accessorKey: 'reason',
        header: t('webhook_calcom.inbox.columns.reason', 'Reason'),
        cell: ({ row }) =>
          row.original.status === 'resolved' ? (
            <StatusBadge variant={transcriptStatusVariant(row.original.status)} dot>
              {translateTranscriptStatus(t, row.original.status)}
            </StatusBadge>
          ) : (
            translateTranscriptReason(t, row.original.reason)
          ),
      },
      {
        accessorKey: 'createdAt',
        header: t('webhook_calcom.inbox.columns.received', 'Received'),
        cell: ({ row }) => formatTranscriptDateTime(row.original.createdAt) ?? noValue,
      },
    ]
  }, [t])

  const isPendingView = status === 'pending'

  return (
    <Page>
      <PageBody>
        <DataTable<UnassignedTranscriptRow>
          title={t('webhook_calcom.inbox.list.title', 'Unassigned transcripts')}
          titleHeadingLevel={1}
          columns={columns}
          data={rows}
          filters={filters}
          filterValues={filterValues}
          onFiltersApply={(next) => {
            setFilterValues(next)
            setPage(1)
          }}
          onFiltersClear={() => {
            setFilterValues(DEFAULT_FILTERS)
            setPage(1)
          }}
          refreshButton={{ label: t('webhook_calcom.inbox.actions.refresh', 'Refresh'), onRefresh: reload }}
          bulkActions={
            access.canManage && isPendingView
              ? [
                  {
                    id: 'dismiss',
                    label: t('webhook_calcom.inbox.bulkDismiss.action', 'Dismiss selected'),
                    destructive: true,
                    onExecute: handleBulkDismiss,
                  },
                ]
              : undefined
          }
          rowActions={(row) => {
            const items: RowActionItem[] = [
              {
                id: 'open',
                label: t('webhook_calcom.inbox.actions.view', 'View'),
                onSelect: () => router.push(buildTranscriptDetailHref(row.id)),
              },
            ]
            if (row.status === 'pending' && access.canAssign) {
              items.push({
                id: 'assign',
                label: t('webhook_calcom.inbox.actions.assign', 'Assign to person'),
                onSelect: () => setAssignTarget(row),
              })
            }
            if (row.status === 'resolved' && row.resolvedEntityId && access.canViewPeople) {
              const personId = row.resolvedEntityId
              items.push({
                id: 'open-person',
                label: t('webhook_calcom.inbox.actions.openPerson', 'Open person'),
                onSelect: () => router.push(buildPersonHref(personId)),
              })
            }
            if (row.status === 'pending' && access.canManage) {
              items.push({
                id: 'delete',
                label: t('webhook_calcom.inbox.actions.dismiss', 'Dismiss'),
                destructive: true,
                onSelect: () => {
                  void handleDismiss(row)
                },
              })
            }
            return <RowActions items={items} />
          }}
          emptyState={
            <ListEmptyState
              entityName={t('webhook_calcom.inbox.list.entityPlural', 'unassigned transcripts')}
              title={
                isPendingView
                  ? t('webhook_calcom.inbox.list.emptyPendingTitle', 'No transcripts waiting for assignment')
                  : t('webhook_calcom.inbox.list.emptyResolvedTitle', 'No resolved transcripts yet')
              }
              description={t(
                'webhook_calcom.inbox.list.emptyDescription',
                'Meeting transcripts that match no CRM person appear here.',
              )}
            />
          }
          error={loadError ? <ErrorMessage label={loadError} /> : null}
          pagination={{ page, pageSize: PAGE_SIZE, total, totalPages, totalIsCapped, onPageChange: setPage }}
          isLoading={isLoading}
        />
      </PageBody>
      {ConfirmDialogElement}
      <AssignTranscriptDialog
        open={assignTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAssignTarget(null)
        }}
        transcript={assignTarget}
        onAssigned={() => {
          setAssignTarget(null)
          reload()
        }}
      />
    </Page>
  )
}
