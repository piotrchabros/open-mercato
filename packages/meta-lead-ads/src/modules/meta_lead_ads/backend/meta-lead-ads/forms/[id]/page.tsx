"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { fetchCustomFieldDefinitionsPayload, type CustomFieldDefDto } from '@open-mercato/ui/backend/utils/customFieldDefs'
import { LookupMultiPicker, LookupSinglePicker } from '@open-mercato/ui/backend/inputs/LookupPickers'
import { createIdsLookupSource, pickLookupString } from '@open-mercato/ui/backend/inputs/lookupSources'
import { RecordNotFoundState, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { DataLoader } from '@open-mercato/ui/primitives/DataLoader'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type {
  FieldMappingEntryDto,
  FormDto,
  FormUpdateInput,
  LeadEventDetailDto,
  OwnerMode,
  PagedResponse,
  TestLeadResponse,
} from '../../../../components/types'
import { LeadEventStatusBadge } from '../../../../components/StatusBadges'

const PERSON_PROFILE_ENTITY_ID = 'customers:customer_person_profile'
const COMPANY_PROFILE_ENTITY_ID = 'customers:customer_company_profile'
const MAPPING_FIELD_PREFIX = 'mapping__'
const PERSON_TARGET_FIELDS = ['firstName', 'lastName', 'fullName', 'displayName', 'primaryEmail', 'primaryPhone', 'jobTitle', 'city']
const COMPANY_TARGET_FIELDS = ['displayName', 'domain']
const TEST_LEAD_POLL_INTERVAL_MS = 2000
const TEST_LEAD_POLL_LIMIT = 15
const PENDING_LEAD_STATUSES = ['received', 'processing', 'retrying']
const OWNER_MODES: OwnerMode[] = ['none', 'fixed', 'round_robin']

type PipelineOption = { id: string; name: string }
type StageOption = { id: string; label: string; order: number }
type SelectOption = { value: string; label: string }

const userLookupSource = createIdsLookupSource('meta-lead-ads-users', '/api/auth/users', (item) => {
  const value = pickLookupString(item, 'id')
  if (!value) return null
  const name = pickLookupString(item, 'name')
  const email = pickLookupString(item, 'email')
  return { value, label: name || email || value, description: name && email ? email : null }
})

function PipelineSelect({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled: boolean }) {
  const t = useT()
  const [pipelines, setPipelines] = React.useState<PipelineOption[]>([])
  React.useEffect(() => {
    let active = true
    apiCall<{ items?: PipelineOption[] }>('/api/customers/pipelines').then((call) => {
      if (active && call.ok) setPipelines(call.result?.items ?? [])
    })
    return () => { active = false }
  }, [])
  return (
    <Select value={value || undefined} onValueChange={(next) => onChange(next ?? '')} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={t('meta_lead_ads.forms.edit.pipeline.placeholder', 'Select pipeline')} />
      </SelectTrigger>
      <SelectContent>
        {pipelines.map((pipeline) => (
          <SelectItem key={pipeline.id} value={pipeline.id}>{pipeline.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function StageSelect({
  pipelineId,
  value,
  onChange,
  disabled,
}: {
  pipelineId: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const t = useT()
  const [stages, setStages] = React.useState<StageOption[]>([])
  React.useEffect(() => {
    if (!pipelineId) {
      setStages([])
      return
    }
    let active = true
    apiCall<{ items?: StageOption[] }>(`/api/customers/pipeline-stages?pipelineId=${encodeURIComponent(pipelineId)}`).then((call) => {
      if (active && call.ok) setStages([...(call.result?.items ?? [])].sort((left, right) => left.order - right.order))
    })
    return () => { active = false }
  }, [pipelineId])
  return (
    <Select value={value || undefined} onValueChange={(next) => onChange(next ?? '')} disabled={disabled || !pipelineId}>
      <SelectTrigger>
        <SelectValue placeholder={t('meta_lead_ads.forms.edit.stage.placeholder', 'Select stage')} />
      </SelectTrigger>
      <SelectContent>
        {stages.map((stage) => (
          <SelectItem key={stage.id} value={stage.id}>{stage.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TestLeadPanel({ result, onDismiss }: { result: LeadEventDetailDto | null; onDismiss: () => void }) {
  const t = useT()
  if (!result) return null
  return (
    <Alert
      status={result.status === 'processed' ? 'success' : result.status === 'failed' || result.status === 'dead_lettered' ? 'error' : 'information'}
      dismissible
      onDismiss={onDismiss}
      className="mb-4"
      data-testid="meta-lead-ads-test-lead-result"
    >
      <p className="font-medium">
        {t('meta_lead_ads.forms.testLead.result.status', 'Test lead status')}
        {' '}
        <LeadEventStatusBadge status={result.status} />
      </p>
      {result.lastError ? <p className="text-sm">{result.lastError}</p> : null}
      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        {result.personId ? (
          <Link className="underline" href={`/backend/customers/people/${result.personId}`}>
            {t('meta_lead_ads.forms.testLead.result.person', 'Open created person')}
          </Link>
        ) : null}
        {result.dealId ? (
          <Link className="underline" href={`/backend/customers/deals/${result.dealId}`}>
            {t('meta_lead_ads.forms.testLead.result.deal', 'Open created deal')}
          </Link>
        ) : null}
        <Link className="underline" href="/backend/meta-lead-ads/leads">
          {t('meta_lead_ads.forms.testLead.result.leadEvent', 'Open lead event')}
        </Link>
      </div>
    </Alert>
  )
}

export default function EditMetaLeadFormPage({ params }: { params?: { id?: string } }) {
  const t = useT()
  const router = useRouter()
  const formId = params?.id ?? ''
  const [form, setForm] = React.useState<FormDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [personDefinitions, setPersonDefinitions] = React.useState<CustomFieldDefDto[]>([])
  const [companyDefinitions, setCompanyDefinitions] = React.useState<CustomFieldDefDto[]>([])
  const [testLeadId, setTestLeadId] = React.useState<string | null>(null)
  const [testLeadResult, setTestLeadResult] = React.useState<LeadEventDetailDto | null>(null)
  const [sendingTestLead, setSendingTestLead] = React.useState(false)

  const mutationContextId = `meta-lead-ads-form:${formId}:test-lead`
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: mutationContextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let active = true
    async function loadForm() {
      try {
        const payload = await readApiResultOrThrow<PagedResponse<FormDto>>(
          `/api/meta_lead_ads/forms?id=${encodeURIComponent(formId)}`,
        )
        if (!active) return
        const record = payload.items?.[0] ?? null
        if (record) setForm(record)
        else setIsNotFound(true)
      } catch {
        if (active) setError(t('meta_lead_ads.forms.edit.errors.load', 'Failed to load the lead form.'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadForm()
    return () => { active = false }
  }, [formId, t])

  React.useEffect(() => {
    let active = true
    Promise.all([
      fetchCustomFieldDefinitionsPayload(PERSON_PROFILE_ENTITY_ID),
      fetchCustomFieldDefinitionsPayload(COMPANY_PROFILE_ENTITY_ID),
    ]).then(([person, company]) => {
      if (!active) return
      setPersonDefinitions(person.items ?? [])
      setCompanyDefinitions(company.items ?? [])
    }).catch(() => {})
    return () => { active = false }
  }, [])

  React.useEffect(() => {
    if (!testLeadId) return
    let active = true
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      attempts += 1
      const call = await apiCall<LeadEventDetailDto>(`/api/meta_lead_ads/lead-events/${encodeURIComponent(testLeadId)}`)
      if (!active) return
      if (call.ok && call.result) {
        setTestLeadResult(call.result)
        if (!PENDING_LEAD_STATUSES.includes(call.result.status)) return
      }
      if (attempts < TEST_LEAD_POLL_LIMIT) timer = setTimeout(poll, TEST_LEAD_POLL_INTERVAL_MS)
    }
    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [testLeadId])

  const targetOptions = React.useMemo<SelectOption[]>(() => {
    const person = PERSON_TARGET_FIELDS.map((field) => ({
      value: `person.${field}`,
      label: t(`meta_lead_ads.forms.edit.target.person.${field}`, `Person: ${field}`),
    }))
    const company = COMPANY_TARGET_FIELDS.map((field) => ({
      value: `company.${field}`,
      label: t(`meta_lead_ads.forms.edit.target.company.${field}`, `Company: ${field}`),
    }))
    const personCustom = personDefinitions.map((definition) => ({
      value: `person.cf:${definition.key}`,
      label: t('meta_lead_ads.forms.edit.target.personCustom', 'Person custom field: {label}', { label: definition.label || definition.key }),
    }))
    const companyCustom = companyDefinitions.map((definition) => ({
      value: `company.cf:${definition.key}`,
      label: t('meta_lead_ads.forms.edit.target.companyCustom', 'Company custom field: {label}', { label: definition.label || definition.key }),
    }))
    const special = [
      { value: 'note', label: t('meta_lead_ads.forms.edit.target.note', 'Add to note') },
      { value: 'consent', label: t('meta_lead_ads.forms.edit.target.consent', 'Record as consent') },
      { value: 'ignore', label: t('meta_lead_ads.forms.edit.target.ignore', 'Ignore') },
    ]
    return [...person, ...company, ...personCustom, ...companyCustom, ...special]
  }, [companyDefinitions, personDefinitions, t])

  const groups = React.useMemo<CrudFormGroup[]>(() => {
    if (!form) return []
    const selectedTargets = form.fieldMapping.map((entry) => entry.target)
    const knownTargets = new Set(targetOptions.map((option) => option.value))
    const preservedOptions = selectedTargets
      .filter((target) => !knownTargets.has(target))
      .map((target) => ({ value: target, label: target }))
    const options = [...targetOptions, ...preservedOptions]
    const mappingFields: CrudField[] = form.questions.map((question) => ({
      id: `${MAPPING_FIELD_PREFIX}${question.key}`,
      type: 'select',
      label: question.label || question.key,
      helpText: question.type,
      options,
    }))
    const modeOptions = OWNER_MODES.map((mode) => ({
      value: mode,
      label: t(`meta_lead_ads.forms.edit.ownerMode.${mode}`, mode),
    }))
    return [
      {
        id: 'general',
        column: 1,
        title: t('meta_lead_ads.forms.edit.group.general', 'General'),
        fields: [
          {
            id: 'isEnabled',
            type: 'checkbox',
            label: t('meta_lead_ads.forms.edit.field.isEnabled', 'Import leads from this form'),
          },
        ],
      },
      {
        id: 'mapping',
        column: 1,
        title: t('meta_lead_ads.forms.edit.group.mapping', 'Question mapping'),
        description: t('meta_lead_ads.forms.edit.group.mappingHint', 'Choose where each answer is stored in the CRM.'),
        fields: mappingFields,
      },
      {
        id: 'deal',
        column: 2,
        title: t('meta_lead_ads.forms.edit.group.deal', 'Deal'),
        fields: [
          {
            id: 'createDeal',
            type: 'checkbox',
            label: t('meta_lead_ads.forms.edit.field.createDeal', 'Create a deal for each new lead'),
          },
          {
            id: 'pipelineId',
            type: 'custom',
            label: t('meta_lead_ads.forms.edit.field.pipeline', 'Pipeline'),
            component: ({ value, setValue, setFormValue, values }) => (
              <PipelineSelect
                value={typeof value === 'string' ? value : ''}
                disabled={values?.createDeal !== true}
                onChange={(next) => {
                  setValue(next)
                  setFormValue?.('pipelineStageId', '')
                }}
              />
            ),
          },
          {
            id: 'pipelineStageId',
            type: 'custom',
            label: t('meta_lead_ads.forms.edit.field.stage', 'Stage'),
            component: ({ value, setValue, values }) => (
              <StageSelect
                pipelineId={typeof values?.pipelineId === 'string' ? values.pipelineId : ''}
                value={typeof value === 'string' ? value : ''}
                disabled={values?.createDeal !== true}
                onChange={setValue}
              />
            ),
          },
        ],
      },
      {
        id: 'owner',
        column: 2,
        title: t('meta_lead_ads.forms.edit.group.owner', 'Owner'),
        fields: [
          {
            id: 'ownerMode',
            type: 'select',
            label: t('meta_lead_ads.forms.edit.field.ownerMode', 'Owner assignment'),
            options: modeOptions,
          },
          {
            id: 'ownerUserId',
            type: 'custom',
            label: t('meta_lead_ads.forms.edit.field.ownerUser', 'Owner'),
            component: ({ value, setValue, values }) => (
              <LookupSinglePicker
                source={userLookupSource}
                value={typeof value === 'string' ? value : ''}
                onChange={setValue}
                disabled={values?.ownerMode !== 'fixed'}
                clearable
                placeholder={t('meta_lead_ads.forms.edit.ownerUser.placeholder', 'Search users')}
              />
            ),
          },
          {
            id: 'ownerUserIds',
            type: 'custom',
            label: t('meta_lead_ads.forms.edit.field.ownerUsers', 'Round-robin owners'),
            component: ({ value, setValue, values }) => (
              <LookupMultiPicker
                source={userLookupSource}
                value={Array.isArray(value) ? (value as string[]) : []}
                onChange={setValue}
                disabled={values?.ownerMode !== 'round_robin'}
                placeholder={t('meta_lead_ads.forms.edit.ownerUsers.placeholder', 'Search users')}
              />
            ),
          },
        ],
      },
    ]
  }, [form, t, targetOptions])

  const initialValues = React.useMemo<Record<string, unknown>>(() => {
    if (!form) return {}
    const mappingByQuestion = new Map(form.fieldMapping.map((entry) => [entry.questionKey, entry.target]))
    const mappingValues = Object.fromEntries(
      form.questions.map((question) => [`${MAPPING_FIELD_PREFIX}${question.key}`, mappingByQuestion.get(question.key) ?? 'note']),
    )
    return {
      ...mappingValues,
      id: form.id,
      updatedAt: form.updatedAt,
      isEnabled: form.isEnabled,
      createDeal: form.createDeal,
      pipelineId: form.pipelineId ?? '',
      pipelineStageId: form.pipelineStageId ?? '',
      ownerMode: form.ownerMode,
      ownerUserId: form.ownerUserId ?? '',
      ownerUserIds: form.ownerUserIds,
    }
  }, [form])

  const sendTestLead = React.useCallback(async () => {
    if (!form) return
    setSendingTestLead(true)
    setTestLeadResult(null)
    setTestLeadId(null)
    try {
      const response = await runMutation({
        operation: () => apiCall<TestLeadResponse>(`/api/meta_lead_ads/forms/${encodeURIComponent(form.id)}/test-lead`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        context: {
          formId: mutationContextId,
          resourceKind: 'meta_lead_ads.form',
          resourceId: form.id,
          retryLastMutation,
        },
      })
      if (response.ok && response.result?.leadEventId) {
        setTestLeadId(response.result.leadEventId)
        flash(t('meta_lead_ads.forms.testLead.flash.sent', 'Test lead sent.'), 'success')
      } else {
        const code = (response.result as { code?: string } | null)?.code
        flash(
          code === 'form_disabled'
            ? t('meta_lead_ads.forms.testLead.errors.formDisabled', 'Enable the form before sending a test lead.')
            : t('meta_lead_ads.forms.testLead.errors.failed', 'Failed to send the test lead.'),
          'error',
        )
      }
    } finally {
      setSendingTestLead(false)
    }
  }, [form, mutationContextId, retryLastMutation, runMutation, t])

  const backHref = '/backend/meta-lead-ads'

  if (isNotFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={t('meta_lead_ads.forms.edit.errors.notFound', 'Lead form not found.')}
            backHref={backHref}
            backLabel={t('meta_lead_ads.forms.edit.backToList', 'Back to Meta Lead Ads')}
          />
        </PageBody>
      </Page>
    )
  }

  if (error) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error} />
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody>
        <DataLoader isLoading={loading}>
          {form ? (
            <>
              {form.needsAttention ? (
                <Alert status="warning" className="mb-4" data-testid="meta-lead-ads-form-attention">
                  <p className="font-medium">{t('meta_lead_ads.forms.edit.attention.title', 'This form needs attention')}</p>
                  <p className="text-sm">
                    {form.attentionReason
                      ? t(`meta_lead_ads.forms.attention.${form.attentionReason}`, form.attentionReason)
                      : null}
                  </p>
                  <p className="text-sm">
                    {t('meta_lead_ads.forms.edit.attention.hint', 'Review the mapping and save to acknowledge.')}
                  </p>
                </Alert>
              ) : null}
              <TestLeadPanel result={testLeadResult} onDismiss={() => { setTestLeadResult(null); setTestLeadId(null) }} />
              <CrudForm
                title={form.name}
                titleHeadingLevel={1}
                backHref={backHref}
                cancelHref={backHref}
                fields={[]}
                groups={groups}
                initialValues={initialValues}
                submitLabel={t('meta_lead_ads.forms.edit.save', 'Save')}
                extraActions={(
                  <Button
                    type="button"
                    variant="outline"
                    disabled={sendingTestLead || !form.isEnabled}
                    onClick={() => { void sendTestLead() }}
                    data-testid="meta-lead-ads-send-test-lead"
                  >
                    {t('meta_lead_ads.forms.testLead.action', 'Send test lead')}
                  </Button>
                )}
                onSubmit={async (values) => {
                  const createDeal = values.createDeal === true
                  const pipelineId = typeof values.pipelineId === 'string' && values.pipelineId ? values.pipelineId : null
                  const pipelineStageId = typeof values.pipelineStageId === 'string' && values.pipelineStageId ? values.pipelineStageId : null
                  const ownerMode = (values.ownerMode as OwnerMode) ?? 'none'
                  const ownerUserId = typeof values.ownerUserId === 'string' && values.ownerUserId ? values.ownerUserId : null
                  const ownerUserIds = Array.isArray(values.ownerUserIds) ? (values.ownerUserIds as string[]) : []
                  const requiredMessage = t('meta_lead_ads.forms.edit.errors.required', 'This field is required.')
                  if (createDeal && !pipelineId) {
                    throw createCrudFormError(requiredMessage, { pipelineId: requiredMessage })
                  }
                  if (createDeal && !pipelineStageId) {
                    throw createCrudFormError(requiredMessage, { pipelineStageId: requiredMessage })
                  }
                  if (ownerMode === 'fixed' && !ownerUserId) {
                    throw createCrudFormError(requiredMessage, { ownerUserId: requiredMessage })
                  }
                  if (ownerMode === 'round_robin' && ownerUserIds.length === 0) {
                    throw createCrudFormError(requiredMessage, { ownerUserIds: requiredMessage })
                  }
                  const fieldMapping: FieldMappingEntryDto[] = form.questions.map((question) => ({
                    questionKey: question.key,
                    target: String(values[`${MAPPING_FIELD_PREFIX}${question.key}`] ?? 'note'),
                  }))
                  const payload: FormUpdateInput = {
                    id: form.id,
                    isEnabled: values.isEnabled === true,
                    fieldMapping,
                    createDeal,
                    pipelineId: createDeal ? pipelineId : null,
                    pipelineStageId: createDeal ? pipelineStageId : null,
                    ownerMode,
                    ownerUserId: ownerMode === 'fixed' ? ownerUserId : null,
                    ownerUserIds: ownerMode === 'round_robin' ? ownerUserIds : [],
                  }
                  await updateCrud('meta_lead_ads/forms', payload)
                  flash(t('meta_lead_ads.forms.edit.flash.saved', 'Lead form saved.'), 'success')
                  router.push(backHref)
                }}
              />
            </>
          ) : null}
        </DataLoader>
      </PageBody>
    </Page>
  )
}
