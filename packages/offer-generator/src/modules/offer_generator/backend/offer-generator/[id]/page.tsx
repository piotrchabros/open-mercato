"use client"

import * as React from 'react'
import { z } from 'zod'
import { useRouter } from 'next/navigation'
import { Download, ExternalLink } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { CrudForm, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { deleteCrud, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { readJsonSafe } from '@open-mercato/ui/backend/utils/serverErrors'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@open-mercato/ui/primitives/tabs'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { offerLanguageSchema, offerStatusSchema } from '../../../data/validators'
import { OFFER_STATUSES, OfferStatusBadge, useOfferStatusLabel } from '../../../components/OfferStatusBadge'
import { CopyPublicLinkButton } from '../../../components/CopyPublicLinkButton'
import { OfferContentEditor } from '../../../components/OfferContentEditor'
import { GenerationPanel } from '../../../components/GenerationPanel'
import { RevisionsList } from '../../../components/RevisionsList'
import { OfferInsightsSection } from '../../../components/OfferInsightsSection'
import type { OfferDto, PagedResponse } from '../../../components/types'

const LIST_HREF = '/backend/offer-generator'
const DELETE_MUTATION_CONTEXT_ID = 'offer_generator-offer-detail:delete'
const PDF_FILENAME_PATTERN = /filename="?([^";]+)"?/i
const GENERATION_FINISHED_EVENTS = new Set(['offer_generator.generation.completed', 'offer_generator.generation.failed'])

type DetailTab = 'content' | 'details' | 'insights'

type DeleteMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

function emptyToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return value
}

function toNullableNumber(value: unknown): unknown {
  const normalized = emptyToNull(value)
  if (normalized === null) return null
  return typeof normalized === 'number' ? normalized : Number(normalized)
}

const detailsFormSchema = z.object({
  title: z.string().trim().min(2).max(200),
  clientName: z.string().trim().min(2).max(200),
  language: offerLanguageSchema,
  status: offerStatusSchema,
  prompt: z.preprocess(emptyToNull, z.string().max(50000).nullable()),
  valueAmount: z.preprocess(toNullableNumber, z.number().finite().nonnegative().max(999_999_999_999.99).nullable()),
  currencyCode: z.preprocess(emptyToNull, z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable()),
  validUntil: z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  sentAt: z.preprocess(emptyToNull, z.string().nullable()),
  respondedAt: z.preprocess(emptyToNull, z.string().nullable()),
  notes: z.preprocess(emptyToNull, z.string().max(20000).nullable()),
  updatedAt: z.string().nullable().optional(),
})

type DetailsFormValues = z.infer<typeof detailsFormSchema>

function isDetailTab(value: string): value is DetailTab {
  return value === 'content' || value === 'details' || value === 'insights'
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : ''
}

function formatDate(value: string | null): string {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : ''
}

function formatAmount(amount: string | null, currencyCode: string | null): string {
  if (amount === null) return ''
  const numeric = Number(amount)
  if (!Number.isFinite(numeric)) return amount
  if (!currencyCode) return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(numeric)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(numeric)
  } catch {
    return `${numeric.toFixed(2)} ${currencyCode}`
  }
}

function readPdfFilename(response: Response, fallback: string): string {
  const header = response.headers?.get?.('content-disposition') ?? ''
  const match = PDF_FILENAME_PATTERN.exec(header)
  return match?.[1] ?? fallback
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function OfferDetailPage({ params }: { params?: { id?: string } }) {
  const t = useT()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload } = useBackendChrome()
  const grantedFeatures = payload?.grantedFeatures ?? []
  const canManage = hasFeature(grantedFeatures, 'offer_generator.manage')
  const canGenerate = hasFeature(grantedFeatures, 'offer_generator.generate')
  const canReadSettings = hasFeature(grantedFeatures, 'offer_generator.settings.manage')
  const statusLabel = useOfferStatusLabel()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const offerId = params?.id ?? null

  const [offer, setOffer] = React.useState<OfferDto | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<DetailTab>('content')
  const [generationActive, setGenerationActive] = React.useState(false)
  const [pdfLoading, setPdfLoading] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<DeleteMutationContext>({
    contextId: DELETE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const loadOffer = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!offerId) {
        setIsNotFound(true)
        setIsLoading(false)
        return
      }
      const silent = options?.silent === true
      if (!silent) setIsLoading(true)
      try {
        const call = await apiCall<PagedResponse<OfferDto>>(
          `/api/offer_generator/offers?id=${encodeURIComponent(offerId)}&page=1&pageSize=1`,
          undefined,
          { fallback: null },
        )
        const record = call.ok ? call.result?.items?.[0] ?? null : null
        if (record) {
          setOffer(record)
          setIsNotFound(false)
          setError(null)
          return
        }
        if (call.ok || call.status === 404) {
          setIsNotFound(true)
          return
        }
        setError(t('offer_generator.detail.loadError', 'Failed to load the offer.'))
      } catch {
        setError(t('offer_generator.detail.loadError', 'Failed to load the offer.'))
      } finally {
        if (!silent) setIsLoading(false)
      }
    },
    [offerId, t],
  )

  React.useEffect(() => {
    void loadOffer()
  }, [loadOffer, scopeVersion])

  const reloadOffer = React.useCallback(() => loadOffer({ silent: true }), [loadOffer])

  const handleConflictRefresh = React.useCallback(() => {
    void loadOffer({ silent: true })
  }, [loadOffer])

  useAppEvent(
    'offer_generator.generation.*',
    (event) => {
      if (activeTab === 'content' || !offerId) return
      if (!GENERATION_FINISHED_EVENTS.has(event.id) || event.payload.offerId !== offerId) return
      setGenerationActive(false)
      void loadOffer({ silent: true })
    },
    [activeTab, loadOffer, offerId],
  )

  const handleDownloadPdf = React.useCallback(async () => {
    if (!offer || pdfLoading) return
    setPdfLoading(true)
    try {
      const call = await apiCall<Blob>(
        `/api/offer_generator/offers/${encodeURIComponent(offer.id)}/pdf`,
        undefined,
        { parse: async (response) => (response.ok ? response.blob() : null) },
      )
      if (call.ok && call.result) {
        triggerBlobDownload(call.result, readPdfFilename(call.response, `${offer.slug}.pdf`))
        return
      }
      if (call.status === 503) {
        flash(t('offer_generator.detail.pdf.unavailable', 'PDF export is unavailable right now. Try again shortly.'), 'error')
        return
      }
      const body = await readJsonSafe<{ error?: unknown }>(call.response, null)
      const message =
        body && typeof body.error === 'string' && body.error
          ? body.error
          : t('offer_generator.detail.pdf.error', 'Failed to download the PDF.')
      flash(message, 'error')
    } catch {
      flash(t('offer_generator.detail.pdf.error', 'Failed to download the PDF.'), 'error')
    } finally {
      setPdfLoading(false)
    }
  }, [offer, pdfLoading, t])

  const handleDelete = React.useCallback(async () => {
    if (!offer || isDeleting) return
    const confirmed = await confirm({
      title: t('offer_generator.list.deleteConfirm', 'Delete this offer? Its public link will stop working.'),
      variant: 'destructive',
    })
    if (!confirmed) return
    setIsDeleting(true)
    try {
      await runMutation({
        operation: () =>
          withScopedApiRequestHeaders(buildOptimisticLockHeader(offer.updatedAt), () =>
            deleteCrud('offer_generator/offers', {
              body: { id: offer.id },
              errorMessage: t('offer_generator.list.deleteError', 'Failed to delete the offer.'),
            }),
          ),
        context: {
          formId: DELETE_MUTATION_CONTEXT_ID,
          resourceKind: 'offer_generator.offer',
          resourceId: offer.id,
          retryLastMutation,
        },
        mutationPayload: { id: offer.id },
      })
      flash(t('offer_generator.list.deleteSuccess', 'Offer deleted.'), 'success')
      router.push(LIST_HREF)
    } catch (err) {
      if (surfaceRecordConflict(err, t, { onRefresh: handleConflictRefresh })) return
      const message =
        err instanceof Error && err.message
          ? err.message
          : t('offer_generator.list.deleteError', 'Failed to delete the offer.')
      flash(message, 'error')
    } finally {
      setIsDeleting(false)
    }
  }, [confirm, handleConflictRefresh, isDeleting, offer, retryLastMutation, router, runMutation, t])

  const detailGroups = React.useMemo<CrudFormGroup[]>(() => {
    const languageOptions = offerLanguageSchema.options.map((language) => ({
      value: language,
      label: t(`offer_generator.languages.${language}`, language),
    }))
    const statusOptions = OFFER_STATUSES.map((status) => ({ value: status, label: statusLabel(status) }))
    return [
      {
        id: 'general',
        column: 1,
        title: t('offer_generator.create.groups.general', 'Offer'),
        fields: [
          {
            id: 'title',
            type: 'text',
            label: t('offer_generator.fields.title', 'Title'),
            required: true,
            maxLength: 200,
          },
          {
            id: 'clientName',
            type: 'text',
            label: t('offer_generator.fields.clientName', 'Client name'),
            required: true,
            maxLength: 200,
          },
          {
            id: 'language',
            type: 'select',
            label: t('offer_generator.fields.language', 'Language'),
            options: languageOptions,
            required: true,
          },
          {
            id: 'prompt',
            type: 'textarea',
            label: t('offer_generator.fields.prompt', 'Brief for the AI'),
            rows: 8,
            maxLength: 50000,
          },
          {
            id: 'notes',
            type: 'textarea',
            label: t('offer_generator.fields.notes', 'Internal notes'),
            description: t('offer_generator.detail.notes.description', 'Visible only to your team, never on the public offer.'),
            rows: 4,
            maxLength: 20000,
          },
        ],
      },
      {
        id: 'lifecycle',
        column: 2,
        title: t('offer_generator.detail.groups.lifecycle', 'Status'),
        fields: [
          {
            id: 'status',
            type: 'select',
            label: t('offer_generator.fields.status', 'Status'),
            options: statusOptions,
            required: true,
          },
          {
            id: 'sentAt',
            type: 'datetime',
            label: t('offer_generator.fields.sentAt', 'Sent at'),
          },
          {
            id: 'respondedAt',
            type: 'datetime',
            label: t('offer_generator.fields.respondedAt', 'Responded at'),
          },
        ],
      },
      {
        id: 'commercial',
        column: 2,
        title: t('offer_generator.create.groups.commercial', 'Commercial terms'),
        fields: [
          {
            id: 'valueAmount',
            type: 'number',
            label: t('offer_generator.fields.valueAmount', 'Value'),
          },
          {
            id: 'currencyCode',
            type: 'text',
            label: t('offer_generator.fields.currencyCode', 'Currency'),
            placeholder: 'PLN',
            maxLength: 3,
          },
          {
            id: 'validUntil',
            type: 'date',
            label: t('offer_generator.fields.validUntil', 'Valid until'),
          },
        ],
      },
    ]
  }, [statusLabel, t])

  const detailInitialValues = React.useMemo<Partial<DetailsFormValues> | undefined>(() => {
    if (!offer) return undefined
    const numericValue = offer.valueAmount === null ? null : Number(offer.valueAmount)
    return {
      title: offer.title,
      clientName: offer.clientName,
      language: offer.language,
      status: offer.status,
      prompt: offer.prompt ?? null,
      valueAmount: numericValue !== null && Number.isFinite(numericValue) ? numericValue : null,
      currencyCode: offer.currencyCode,
      validUntil: offer.validUntil,
      sentAt: offer.sentAt,
      respondedAt: offer.respondedAt,
      notes: offer.notes ?? null,
      updatedAt: offer.updatedAt,
    }
  }, [offer])

  const handleDetailsSubmit = React.useCallback(
    async (values: DetailsFormValues) => {
      if (!offer) return
      await updateCrud(
        'offer_generator/offers',
        {
          id: offer.id,
          title: values.title,
          clientName: values.clientName,
          language: values.language,
          status: values.status,
          prompt: values.prompt,
          valueAmount: values.valueAmount,
          currencyCode: values.currencyCode,
          validUntil: values.validUntil,
          sentAt: values.sentAt,
          respondedAt: values.respondedAt,
          notes: values.notes,
        },
        { errorMessage: t('offer_generator.detail.saveError', 'Failed to save the offer.') },
      )
      flash(t('offer_generator.detail.saved', 'Offer saved.'), 'success')
      await loadOffer({ silent: true })
    },
    [loadOffer, offer, t],
  )

  if (isLoading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t('offer_generator.detail.loading', 'Loading offer...')} />
        </PageBody>
      </Page>
    )
  }

  if (isNotFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={t('offer_generator.detail.notFound', 'Offer not found.')}
            backHref={LIST_HREF}
            backLabel={t('offer_generator.detail.backToList', 'Back to offers')}
          />
        </PageBody>
      </Page>
    )
  }

  if (error || !offer) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('offer_generator.detail.loadError', 'Failed to load the offer.')} />
        </PageBody>
      </Page>
    )
  }

  const generationLocked =
    generationActive || offer.generationStatus === 'queued' || offer.generationStatus === 'running'
  const openPublicLabel = t('offer_generator.publicLink.open', 'Open public link')

  const readOnlyDetails: Array<{ id: string; label: string; value: string }> = [
    { id: 'clientName', label: t('offer_generator.fields.clientName', 'Client name'), value: offer.clientName },
    { id: 'language', label: t('offer_generator.fields.language', 'Language'), value: t(`offer_generator.languages.${offer.language}`, offer.language) },
    { id: 'status', label: t('offer_generator.fields.status', 'Status'), value: statusLabel(offer.status) },
    { id: 'valueAmount', label: t('offer_generator.fields.valueAmount', 'Value'), value: formatAmount(offer.valueAmount, offer.currencyCode) },
    { id: 'validUntil', label: t('offer_generator.fields.validUntil', 'Valid until'), value: formatDate(offer.validUntil) },
    { id: 'sentAt', label: t('offer_generator.fields.sentAt', 'Sent at'), value: formatDateTime(offer.sentAt) },
    { id: 'respondedAt', label: t('offer_generator.fields.respondedAt', 'Responded at'), value: formatDateTime(offer.respondedAt) },
    { id: 'notes', label: t('offer_generator.fields.notes', 'Internal notes'), value: offer.notes ?? '' },
  ]

  return (
    <Page>
      <PageBody>
        <FormHeader
          mode="detail"
          backHref={LIST_HREF}
          backLabel={t('offer_generator.detail.backToList', 'Back to offers')}
          title={offer.title}
          entityTypeLabel={t('offer_generator.detail.entityType', 'Offer')}
          subtitle={offer.clientName}
          statusBadge={<OfferStatusBadge status={offer.status} />}
          utilityActions={
            <>
              <CopyPublicLinkButton url={offer.publicUrl} iconOnly />
              <IconButton asChild variant="ghost" aria-label={openPublicLabel} title={openPublicLabel}>
                <a href={offer.publicUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                </a>
              </IconButton>
            </>
          }
          menuActions={[
            {
              id: 'download-pdf',
              label: t('offer_generator.detail.actions.downloadPdf', 'Download PDF'),
              icon: Download,
              onSelect: () => {
                void handleDownloadPdf()
              },
              disabled: !offer.hasHtml || pdfLoading,
              loading: pdfLoading,
            },
          ]}
          onDelete={canManage ? () => void handleDelete() : undefined}
          deleteLabel={t('offer_generator.list.actions.delete', 'Delete')}
          isDeleting={isDeleting}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (isDetailTab(value)) setActiveTab(value)
          }}
          variant="underline"
          className="mt-6"
        >
          <TabsList aria-label={t('offer_generator.detail.tabs.label', 'Offer sections')}>
            <TabsTrigger value="content">{t('offer_generator.detail.tabs.content', 'Content')}</TabsTrigger>
            <TabsTrigger value="details">{t('offer_generator.detail.tabs.details', 'Details')}</TabsTrigger>
            <TabsTrigger value="insights" count={offer.viewCount > 0 ? offer.viewCount : undefined}>
              {t('offer_generator.detail.tabs.insights', 'Insights')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="content" className="mt-4">
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <OfferContentEditor
                  offer={offer}
                  canManage={canManage}
                  locked={generationLocked}
                  onSaved={reloadOffer}
                  onConflict={handleConflictRefresh}
                />
              </div>
              <div className="space-y-4">
                <GenerationPanel
                  offer={offer}
                  canGenerate={canGenerate}
                  canReadSettings={canReadSettings}
                  onRunFinished={reloadOffer}
                  onActiveChange={setGenerationActive}
                />
                <RevisionsList
                  offer={offer}
                  canManage={canManage}
                  locked={generationLocked}
                  onRestored={reloadOffer}
                  onConflict={handleConflictRefresh}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="details" className="mt-4">
            {canManage && detailInitialValues ? (
              <CrudForm<DetailsFormValues>
                key={offer.updatedAt ?? offer.id}
                embedded
                fields={[]}
                groups={detailGroups}
                initialValues={detailInitialValues}
                schema={detailsFormSchema}
                submitLabel={t('offer_generator.detail.save', 'Save')}
                onSubmit={handleDetailsSubmit}
              />
            ) : (
              <dl className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
                {readOnlyDetails.map((item) => (
                  <div key={item.id} className="space-y-1">
                    <dt className="text-xs text-muted-foreground">{item.label}</dt>
                    <dd className="whitespace-pre-wrap text-sm">{item.value || '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </TabsContent>

          <TabsContent value="insights" className="mt-4">
            <OfferInsightsSection offerId={offer.id} />
          </TabsContent>
        </Tabs>
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}
