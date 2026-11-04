'use client'

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useDialogKeyHandler } from '@open-mercato/ui/hooks/useDialogKeyHandler'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PageStatusBadge } from './StatusBadges'
import { LeadsAccessHelp } from './LeadsAccessHelp'
import type {
  AvailablePageDto,
  ConnectionDto,
  FormDto,
  PageAssignInput,
  PageCheckResponse,
  PageDto,
  PagedResponse,
  SyncFormsResponse,
} from './types'

type PagesSectionProps = {
  canManage: boolean
  onChanged?: () => void
}

type OrganizationOption = {
  id: string
  label: string
}

type OrganizationNode = {
  id: string
  name: string
  depth?: number
  selectable?: boolean
  children?: OrganizationNode[]
}

type ErrorBody = {
  error?: string
  code?: string
}

class PagesRequestError extends Error {
  status: number
  body: ErrorBody

  constructor(status: number, body: ErrorBody) {
    super(`[internal] pages request failed (${status})`)
    this.status = status
    this.body = body
  }
}

const MUTATION_CONTEXT_ID = 'meta_lead_ads-pages'
const PAGE_SIZE = 100

function flattenOrganizations(nodes: OrganizationNode[], depth = 0): OrganizationOption[] {
  return nodes.flatMap((node) => {
    const own: OrganizationOption[] = node.selectable === false
      ? []
      : [{ id: node.id, label: `${'  '.repeat(depth)}${node.name}` }]
    return [...own, ...flattenOrganizations(node.children ?? [], depth + 1)]
  })
}

async function requestOrThrow<TResult>(url: string, init?: RequestInit): Promise<TResult | null> {
  const call = await apiCall<TResult & ErrorBody>(url, init)
  if (!call.ok) {
    throw new PagesRequestError(call.status, (call.result ?? {}) as ErrorBody)
  }
  return call.result
}

function readErrorCode(error: unknown): string | null {
  if (error instanceof PagesRequestError && typeof error.body.code === 'string') return error.body.code
  return null
}

export function PagesSection({ canManage, onChanged }: PagesSectionProps) {
  const t = useT()
  const { runMutation } = useGuardedMutation<Record<string, unknown>>({ contextId: MUTATION_CONTEXT_ID })
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [connections, setConnections] = React.useState<ConnectionDto[]>([])
  const [pages, setPages] = React.useState<PageDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [busyPageId, setBusyPageId] = React.useState<string | null>(null)
  const [expandedPageId, setExpandedPageId] = React.useState<string | null>(null)
  const [formsByPage, setFormsByPage] = React.useState<Record<string, FormDto[]>>({})
  const [formsLoadingPageId, setFormsLoadingPageId] = React.useState<string | null>(null)
  const [assignOpen, setAssignOpen] = React.useState(false)
  const [connectionId, setConnectionId] = React.useState('')
  const [availablePages, setAvailablePages] = React.useState<AvailablePageDto[]>([])
  const [availableLoading, setAvailableLoading] = React.useState(false)
  const [availableError, setAvailableError] = React.useState<string | null>(null)
  const [metaPageId, setMetaPageId] = React.useState('')
  const [organizations, setOrganizations] = React.useState<OrganizationOption[]>([])
  const [organizationId, setOrganizationId] = React.useState('')
  const [assignError, setAssignError] = React.useState<string | null>(null)
  const [assigning, setAssigning] = React.useState(false)

  const usableConnections = React.useMemo(
    () => connections.filter((connection) => connection.status === 'active'),
    [connections],
  )

  const loadPages = React.useCallback(async () => {
    const connectionsCall = await apiCall<PagedResponse<ConnectionDto>>(`/api/meta_lead_ads/connections?pageSize=${PAGE_SIZE}`)
    if (connectionsCall.ok && connectionsCall.result) setConnections(connectionsCall.result.items)
    const call = await apiCall<PagedResponse<PageDto>>(`/api/meta_lead_ads/pages?pageSize=${PAGE_SIZE}`)
    if (!call.ok || !call.result) {
      setLoadError(t('meta_lead_ads.pages.errors.load', 'Failed to load Pages.'))
      setLoading(false)
      return
    }
    setLoadError(null)
    setPages(call.result.items)
    setLoading(false)
  }, [t])

  React.useEffect(() => {
    void loadPages()
  }, [loadPages])

  const loadForms = React.useCallback(async (pageId: string) => {
    setFormsLoadingPageId(pageId)
    const call = await apiCall<PagedResponse<FormDto>>(
      `/api/meta_lead_ads/forms?pageId=${encodeURIComponent(pageId)}&pageSize=${PAGE_SIZE}`,
    )
    if (call.ok && call.result) {
      const items = call.result.items
      setFormsByPage((current) => ({ ...current, [pageId]: items }))
    } else {
      flash(t('meta_lead_ads.pages.errors.loadForms', 'Failed to load forms.'), 'error')
    }
    setFormsLoadingPageId(null)
  }, [t])

  const refreshAll = React.useCallback(async () => {
    await loadPages()
    if (expandedPageId) await loadForms(expandedPageId)
    onChanged?.()
  }, [expandedPageId, loadForms, loadPages, onChanged])

  const toggleForms = React.useCallback(async (pageId: string) => {
    if (expandedPageId === pageId) {
      setExpandedPageId(null)
      return
    }
    setExpandedPageId(pageId)
    await loadForms(pageId)
  }, [expandedPageId, loadForms])

  const runPageAction = React.useCallback(async (
    page: PageDto,
    operation: () => Promise<void>,
    errorMessage: string,
  ) => {
    setBusyPageId(page.id)
    try {
      await runMutation({ operation, context: { pageId: page.id }, mutationPayload: { pageId: page.id } })
    } catch (error) {
      if (!(error instanceof PagesRequestError) || error.status !== 409) {
        flash(errorMessage, 'error')
      }
    } finally {
      setBusyPageId(null)
    }
  }, [runMutation])

  const handleCheck = React.useCallback((page: PageDto) => {
    void runPageAction(page, async () => {
      const result = await requestOrThrow<PageCheckResponse>(
        `/api/meta_lead_ads/pages/${page.id}/check`,
        { method: 'POST' },
      )
      flash(
        t('meta_lead_ads.pages.flash.checked', 'Page status refreshed.'),
        result?.subscriptionStatus === 'active' ? 'success' : 'warning',
      )
      await refreshAll()
    }, t('meta_lead_ads.pages.errors.check', 'Failed to check the Page.'))
  }, [refreshAll, runPageAction, t])

  const handleSyncForms = React.useCallback((page: PageDto) => {
    void runPageAction(page, async () => {
      const result = await requestOrThrow<SyncFormsResponse>(
        `/api/meta_lead_ads/pages/${page.id}/sync-forms`,
        { method: 'POST' },
      )
      flash(
        t('meta_lead_ads.pages.flash.formsSynced', 'Forms synced: {created} new, {updated} updated, {flagged} need attention.', {
          created: result?.created ?? 0,
          updated: result?.updated ?? 0,
          flagged: result?.flagged ?? 0,
        }),
        'success',
      )
      await refreshAll()
    }, t('meta_lead_ads.pages.errors.syncForms', 'Failed to sync forms.'))
  }, [refreshAll, runPageAction, t])

  const handleUnassign = React.useCallback(async (page: PageDto) => {
    const confirmed = await confirm({
      title: t('meta_lead_ads.pages.unassign.title', 'Unassign Page'),
      text: t('meta_lead_ads.pages.unassign.text', 'Unassign "{name}"? Lead delivery from this Page will stop.', { name: page.name }),
      confirmText: t('meta_lead_ads.pages.actions.unassign', 'Unassign'),
      variant: 'destructive',
    })
    if (!confirmed) return
    await runPageAction(page, async () => {
      await withScopedApiRequestHeaders(buildOptimisticLockHeader(page.updatedAt), () =>
        requestOrThrow<{ ok: true }>(`/api/meta_lead_ads/pages/${page.id}`, { method: 'DELETE' }),
      )
      flash(t('meta_lead_ads.pages.flash.unassigned', 'Page unassigned.'), 'success')
      setExpandedPageId((current) => (current === page.id ? null : current))
      await refreshAll()
    }, t('meta_lead_ads.pages.errors.unassign', 'Failed to unassign the Page.'))
  }, [confirm, refreshAll, runPageAction, t])

  const openAssign = React.useCallback(async () => {
    setAssignOpen(true)
    setConnectionId(usableConnections.length === 1 ? usableConnections[0].id : '')
    setMetaPageId('')
    setOrganizationId('')
    setAssignError(null)
    if (organizations.length > 0) return
    const call = await apiCall<{ items?: OrganizationNode[]; selectedId?: string | null }>(
      '/api/directory/organization-switcher',
    )
    if (call.ok && call.result) {
      const options = flattenOrganizations(call.result.items ?? [])
      setOrganizations(options)
      const selected = call.result.selectedId
      if (selected && options.some((option) => option.id === selected)) setOrganizationId(selected)
    }
  }, [organizations.length, usableConnections])

  React.useEffect(() => {
    if (!assignOpen || !connectionId) {
      setAvailablePages([])
      return
    }
    let cancelled = false
    setAvailableLoading(true)
    setAvailableError(null)
    setMetaPageId('')
    void apiCall<{ items: AvailablePageDto[] }>(`/api/meta_lead_ads/connections/${connectionId}/available-pages`)
      .then((call) => {
        if (cancelled) return
        if (call.ok && call.result) {
          setAvailablePages(call.result.items)
        } else {
          setAvailablePages([])
          setAvailableError(t('meta_lead_ads.pages.assign.errors.loadAvailable', 'Failed to load Pages from Meta.'))
        }
      })
      .finally(() => {
        if (!cancelled) setAvailableLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [assignOpen, connectionId, t])

  const closeAssign = React.useCallback(() => {
    if (assigning) return
    setAssignOpen(false)
  }, [assigning])

  const canSubmitAssign = Boolean(connectionId && metaPageId && organizationId) && !assigning

  const submitAssign = React.useCallback(async () => {
    if (!connectionId || !metaPageId || !organizationId || assigning) return
    const input: PageAssignInput = { connectionId, metaPageId, organizationId }
    setAssigning(true)
    setAssignError(null)
    try {
      await runMutation({
        operation: () => requestOrThrow<PageDto>('/api/meta_lead_ads/pages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
        context: { connectionId },
        mutationPayload: { ...input },
      })
      flash(t('meta_lead_ads.pages.flash.assigned', 'Page assigned.'), 'success')
      setAssignOpen(false)
      await refreshAll()
    } catch (error) {
      const code = readErrorCode(error)
      if (code === 'page_already_assigned') {
        setAssignError(t('meta_lead_ads.pages.assign.errors.alreadyAssigned', 'This Page is already assigned to another organization.'))
      } else if (code === 'organization_not_visible') {
        setAssignError(t('meta_lead_ads.pages.assign.errors.organizationNotVisible', 'You cannot assign Pages to this organization.'))
      } else if (code === 'graph_error') {
        setAssignError(t('meta_lead_ads.pages.assign.errors.graph', 'Meta did not accept the request. Try again shortly.'))
      } else if (!(error instanceof PagesRequestError) || error.status !== 409) {
        setAssignError(t('meta_lead_ads.pages.assign.errors.generic', 'Failed to assign the Page.'))
      }
    } finally {
      setAssigning(false)
    }
  }, [assigning, connectionId, metaPageId, organizationId, refreshAll, runMutation, t])

  const handleDialogKeyDown = useDialogKeyHandler({
    onConfirm: () => { void submitAssign() },
    onCancel: closeAssign,
    disabled: !canSubmitAssign,
  })

  const connectionName = React.useCallback((id: string) => {
    const connection = connections.find((entry) => entry.id === id)
    return connection?.metaUserName ?? connection?.metaUserId ?? id
  }, [connections])

  const renderForms = (page: PageDto) => {
    if (formsLoadingPageId === page.id && !formsByPage[page.id]) {
      return <LoadingMessage label={t('meta_lead_ads.pages.forms.loading', 'Loading forms...')} />
    }
    const forms = formsByPage[page.id] ?? []
    if (forms.length === 0) {
      return <p className="text-sm text-muted-foreground">{t('meta_lead_ads.pages.forms.empty', 'No forms synced for this Page yet.')}</p>
    }
    return (
      <ul className="divide-y rounded-md border">
        {forms.map((form) => (
          <li key={form.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <Link href={`/backend/meta-lead-ads/forms/${form.id}`} className="text-sm font-medium hover:underline">
              {form.name}
            </Link>
            <span className="flex items-center gap-2">
              {form.needsAttention ? (
                <StatusBadge variant="warning">{t('meta_lead_ads.pages.forms.needsAttention', 'Needs attention')}</StatusBadge>
              ) : null}
              <StatusBadge variant={form.isEnabled ? 'success' : 'neutral'}>
                {form.isEnabled
                  ? t('meta_lead_ads.pages.forms.enabled', 'Enabled')
                  : t('meta_lead_ads.pages.forms.disabled', 'Disabled')}
              </StatusBadge>
            </span>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('meta_lead_ads.pages.title', 'Pages')}</h2>
        {canManage ? (
          <Button type="button" onClick={() => { void openAssign() }} disabled={usableConnections.length === 0}>
            {t('meta_lead_ads.pages.actions.assign', 'Assign Page')}
          </Button>
        ) : null}
      </div>

      {loading ? <LoadingMessage label={t('meta_lead_ads.pages.loading', 'Loading Pages...')} /> : null}
      {!loading && loadError ? <ErrorMessage label={loadError} /> : null}
      {!loading && !loadError && pages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('meta_lead_ads.pages.empty', 'No Pages assigned yet.')}</p>
      ) : null}

      <ul className="space-y-3">
        {pages.map((page) => (
          <li key={page.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{page.name}</span>
                  <PageStatusBadge status={page.subscriptionStatus} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('meta_lead_ads.pages.meta', '{connection} · {count} forms', {
                    connection: connectionName(page.connectionId),
                    count: page.formCount,
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => { void toggleForms(page.id) }}>
                  {expandedPageId === page.id
                    ? t('meta_lead_ads.pages.actions.hideForms', 'Hide forms')
                    : t('meta_lead_ads.pages.actions.showForms', 'Show forms')}
                </Button>
                {canManage ? (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled={busyPageId === page.id} onClick={() => handleCheck(page)}>
                      {t('meta_lead_ads.pages.actions.check', 'Check')}
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={busyPageId === page.id} onClick={() => handleSyncForms(page)}>
                      {t('meta_lead_ads.pages.actions.syncForms', 'Sync forms')}
                    </Button>
                    <Button type="button" variant="destructive" size="sm" disabled={busyPageId === page.id} onClick={() => { void handleUnassign(page) }}>
                      {t('meta_lead_ads.pages.actions.unassign', 'Unassign')}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            {page.subscriptionStatus === 'no_leads_access' ? <LeadsAccessHelp /> : null}
            {page.lastError && page.subscriptionStatus !== 'active' && page.subscriptionStatus !== 'no_leads_access' ? (
              <Alert status="warning">{page.lastError}</Alert>
            ) : null}
            {expandedPageId === page.id ? renderForms(page) : null}
          </li>
        ))}
      </ul>

      <Dialog open={assignOpen} onOpenChange={(open) => { if (!open) closeAssign() }}>
        <DialogContent onKeyDown={handleDialogKeyDown}>
          <DialogHeader>
            <DialogTitle>{t('meta_lead_ads.pages.assign.title', 'Assign Page')}</DialogTitle>
            <DialogDescription>
              {t('meta_lead_ads.pages.assign.description', 'Choose a Facebook Page and the organization that will receive its leads.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('meta_lead_ads.pages.assign.connection', 'Connection')}</label>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('meta_lead_ads.pages.assign.connectionPlaceholder', 'Select a connection')} />
                </SelectTrigger>
                <SelectContent>
                  {usableConnections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.metaUserName ?? connection.metaUserId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('meta_lead_ads.pages.assign.page', 'Facebook Page')}</label>
              {availableLoading ? <LoadingMessage label={t('meta_lead_ads.pages.assign.loadingAvailable', 'Loading Pages from Meta...')} /> : (
                <Select value={metaPageId} onValueChange={setMetaPageId} disabled={!connectionId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('meta_lead_ads.pages.assign.pagePlaceholder', 'Select a Page')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePages.map((available) => (
                      <SelectItem key={available.metaPageId} value={available.metaPageId} disabled={!available.assignable}>
                        {available.assignable
                          ? available.name
                          : t('meta_lead_ads.pages.assign.alreadyAssignedOption', '{name} (already assigned)', { name: available.name })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {availableError ? <p className="text-sm text-status-error-text">{availableError}</p> : null}
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('meta_lead_ads.pages.assign.organization', 'Organization')}</label>
              <Select value={organizationId} onValueChange={setOrganizationId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('meta_lead_ads.pages.assign.organizationPlaceholder', 'Select an organization')} />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {assignError ? <Alert status="error">{assignError}</Alert> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAssign} disabled={assigning}>
              {t('meta_lead_ads.common.cancel', 'Cancel')}
            </Button>
            <Button type="button" onClick={() => { void submitAssign() }} disabled={!canSubmitAssign}>
              {t('meta_lead_ads.pages.assign.submit', 'Assign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialogElement}
    </section>
  )
}

export default PagesSection
