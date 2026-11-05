"use client"

import * as React from 'react'
import { z } from 'zod'
import { useRouter, useSearchParams } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { LookupSinglePicker } from '@open-mercato/ui/backend/inputs/LookupPickers'
import {
  createIdsLookupSource,
  pickLookupString,
  type LookupRemoteItem,
  type LookupSource,
} from '@open-mercato/ui/backend/inputs/lookupSources'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import {
  offerCreateSchema,
  offerCustomerKindSchema,
  offerLanguageSchema,
} from '../../../data/validators'
import type {
  GenerationStartResponse,
  OfferCreateResponse,
  OfferCustomerKind,
  OfferLanguage,
} from '../../../components/types'

const LIST_HREF = '/backend/offer-generator'
const DEFAULT_LANGUAGE: OfferLanguage = 'pl'
const MIN_GENERATE_PROMPT_LENGTH = 10
const GENERATE_MUTATION_CONTEXT_ID = 'offer_generator-offer-create:generate'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const createFormSchema = offerCreateSchema
  .omit({ tenantId: true, organizationId: true, notes: true, status: true })
  .extend({
    customerKind: z.preprocess(emptyToNull, offerCustomerKindSchema.nullable()),
    customerEntityId: z.preprocess(emptyToNull, z.string().uuid().nullable()),
    dealId: z.preprocess(emptyToNull, z.string().uuid().nullable()),
    prompt: z.preprocess(emptyToNull, z.string().max(50000).nullable()),
    valueAmount: z.preprocess(toNullableNumber, z.number().finite().nonnegative().max(999_999_999_999.99).nullable()),
    currencyCode: z.preprocess(emptyToNull, z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullable()),
    validUntil: z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
    generateNow: z.boolean().optional(),
  })

type CreateFormValues = z.infer<typeof createFormSchema>

type GenerateMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

function mapCustomerItem(item: LookupRemoteItem) {
  const value = pickLookupString(item, 'id')
  if (!value) return null
  const label = pickLookupString(item, 'display_name', 'displayName')
  const email = pickLookupString(item, 'primary_email', 'primaryEmail')
  return { value, label: label || email || value, description: label && email ? email : null }
}

function mapDealItem(item: LookupRemoteItem) {
  const value = pickLookupString(item, 'id')
  if (!value) return null
  return { value, label: pickLookupString(item, 'title') || value }
}

const peopleLookupSource = createIdsLookupSource('offer-generator-people', '/api/customers/people', mapCustomerItem)
const companiesLookupSource = createIdsLookupSource('offer-generator-companies', '/api/customers/companies', mapCustomerItem)
const dealsLookupSource = createIdsLookupSource('offer-generator-deals', '/api/customers/deals', mapDealItem)

function customerSourceFor(kind: OfferCustomerKind): LookupSource {
  return kind === 'company' ? companiesLookupSource : peopleLookupSource
}

function buildDealsSource(kind: OfferCustomerKind | null, customerEntityId: string | null): LookupSource {
  if (!kind || !customerEntityId) return dealsLookupSource
  const filterParam = kind === 'company' ? 'companyId' : 'personId'
  const filtered = createIdsLookupSource(
    `offer-generator-deals-${kind}-${customerEntityId}`,
    '/api/customers/deals',
    mapDealItem,
    { [filterParam]: customerEntityId },
  )
  return { id: filtered.id, search: filtered.search, resolve: dealsLookupSource.resolve }
}

function readCustomerKind(value: unknown): OfferCustomerKind | null {
  const parsed = offerCustomerKindSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

async function resolveCustomerLabel(kind: OfferCustomerKind, id: string): Promise<string | null> {
  try {
    const [option] = await customerSourceFor(kind).resolve([id])
    return option?.label && option.label !== id ? option.label : null
  } catch {
    return null
  }
}

type DealCustomerPrefill = {
  customerKind: OfferCustomerKind
  customerEntityId: string
  clientName: string | null
}

type DealLinkedEntity = { id?: unknown; label?: unknown }

type DealLookupResponse = {
  items?: Array<{ people?: DealLinkedEntity[]; companies?: DealLinkedEntity[] }>
}

function pickLinkedEntity(entities: DealLinkedEntity[] | undefined): { id: string; label: string | null } | null {
  for (const entity of entities ?? []) {
    const id = readUuid(entity.id)
    if (!id) continue
    const label = typeof entity.label === 'string' && entity.label.trim() && entity.label !== id ? entity.label.trim() : null
    return { id, label }
  }
  return null
}

async function resolveDealCustomer(dealId: string): Promise<DealCustomerPrefill | null> {
  try {
    const call = await apiCall<DealLookupResponse>(
      `/api/customers/deals?id=${encodeURIComponent(dealId)}&page=1&pageSize=1`,
      undefined,
      { fallback: null },
    )
    const deal = call.ok ? call.result?.items?.[0] : undefined
    if (!deal) return null
    const company = pickLinkedEntity(deal.companies)
    if (company) {
      return {
        customerKind: 'company',
        customerEntityId: company.id,
        clientName: company.label ?? (await resolveCustomerLabel('company', company.id)),
      }
    }
    const person = pickLinkedEntity(deal.people)
    if (person) {
      return {
        customerKind: 'person',
        customerEntityId: person.id,
        clientName: person.label ?? (await resolveCustomerLabel('person', person.id)),
      }
    }
    return null
  } catch {
    return null
  }
}

function DealPicker({
  kind,
  customerEntityId,
  value,
  onChange,
}: {
  kind: OfferCustomerKind | null
  customerEntityId: string | null
  value: string
  onChange: (next: string) => void
}) {
  const t = useT()
  const source = React.useMemo(() => buildDealsSource(kind, customerEntityId), [customerEntityId, kind])
  return (
    <LookupSinglePicker
      key={source.id}
      source={source}
      value={value}
      onChange={onChange}
      clearable
      placeholder={t('offer_generator.create.deal.placeholder', 'Search deals')}
    />
  )
}

export default function CreateOfferPage() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { payload } = useBackendChrome()
  const canGenerate = hasFeature(payload?.grantedFeatures ?? [], 'offer_generator.generate')
  const { runMutation, retryLastMutation } = useGuardedMutation<GenerateMutationContext>({
    contextId: GENERATE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const prefill = React.useMemo(() => {
    const customerKind = readCustomerKind(searchParams?.get('customerKind'))
    const customerEntityId = customerKind ? readUuid(searchParams?.get('customerEntityId')) : null
    return {
      customerKind,
      customerEntityId,
      dealId: readUuid(searchParams?.get('dealId')),
    }
  }, [searchParams])

  const [prefillClientName, setPrefillClientName] = React.useState<string | null>(null)
  const [dealCustomer, setDealCustomer] = React.useState<DealCustomerPrefill | null>(null)
  const [prefillReady, setPrefillReady] = React.useState(!prefill.customerEntityId && !prefill.dealId)

  React.useEffect(() => {
    let active = true
    if (prefill.customerKind && prefill.customerEntityId) {
      setPrefillReady(false)
      resolveCustomerLabel(prefill.customerKind, prefill.customerEntityId).then((label) => {
        if (!active) return
        setPrefillClientName(label)
        setPrefillReady(true)
      })
    } else if (prefill.dealId) {
      setPrefillReady(false)
      resolveDealCustomer(prefill.dealId).then((customer) => {
        if (!active) return
        setDealCustomer(customer)
        setPrefillReady(true)
      })
    } else {
      setPrefillReady(true)
    }
    return () => {
      active = false
    }
  }, [prefill.customerEntityId, prefill.customerKind, prefill.dealId])

  const initialValues = React.useMemo<Partial<CreateFormValues>>(() => ({
    title: '',
    clientName: prefillClientName ?? dealCustomer?.clientName ?? '',
    customerKind: prefill.customerKind ?? dealCustomer?.customerKind ?? null,
    customerEntityId: prefill.customerEntityId ?? dealCustomer?.customerEntityId ?? null,
    dealId: prefill.dealId,
    language: DEFAULT_LANGUAGE,
    prompt: null,
    valueAmount: null,
    currencyCode: null,
    validUntil: null,
    generateNow: false,
  }), [dealCustomer, prefill, prefillClientName])

  const groups = React.useMemo<CrudFormGroup[]>(() => {
    const languageOptions = offerLanguageSchema.options.map((language) => ({
      value: language,
      label: t(`offer_generator.languages.${language}`, language),
    }))
    const customerKindOptions = offerCustomerKindSchema.options.map((kind) => ({
      value: kind,
      label: t(`offer_generator.customerKinds.${kind}`, kind),
    }))
    const generalFields: CrudField[] = [
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
        description: t(
          'offer_generator.create.clientName.description',
          'Shown on the offer and used in its public link. Filled in from the selected customer.',
        ),
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
        description: t(
          'offer_generator.create.prompt.description',
          'Describe the client, the scope, prices and anything the offer must include.',
        ),
        rows: 10,
        maxLength: 50000,
      },
    ]
    if (canGenerate) {
      generalFields.push({
        id: 'generateNow',
        type: 'checkbox',
        label: t('offer_generator.create.generateNow', 'Generate the offer with AI right after saving'),
      })
    }
    return [
      {
        id: 'general',
        column: 1,
        title: t('offer_generator.create.groups.general', 'Offer'),
        fields: generalFields,
      },
      {
        id: 'crm',
        column: 2,
        title: t('offer_generator.create.groups.crm', 'CRM'),
        fields: [
          {
            id: 'customerKind',
            type: 'select',
            label: t('offer_generator.fields.customerKind', 'Customer type'),
            options: customerKindOptions,
          },
          {
            id: 'customerEntityId',
            type: 'custom',
            label: t('offer_generator.fields.customer', 'Customer'),
            component: ({ value, setValue, setFormValue, values }) => {
              const kind = readCustomerKind(values?.customerKind)
              if (!kind) {
                return (
                  <p className="text-sm text-muted-foreground">
                    {t('offer_generator.create.customer.selectKindFirst', 'Choose the customer type first.')}
                  </p>
                )
              }
              return (
                <LookupSinglePicker
                  key={kind}
                  source={customerSourceFor(kind)}
                  value={typeof value === 'string' ? value : ''}
                  clearable
                  placeholder={
                    kind === 'company'
                      ? t('offer_generator.create.customer.placeholderCompany', 'Search companies')
                      : t('offer_generator.create.customer.placeholderPerson', 'Search people')
                  }
                  onChange={(next) => {
                    setValue(next)
                    setFormValue?.('dealId', '')
                    if (!next) return
                    void resolveCustomerLabel(kind, next).then((label) => {
                      if (label) setFormValue?.('clientName', label)
                    })
                  }}
                />
              )
            },
          },
          {
            id: 'dealId',
            type: 'custom',
            label: t('offer_generator.fields.deal', 'Deal'),
            component: ({ value, setValue, values }) => (
              <DealPicker
                kind={readCustomerKind(values?.customerKind)}
                customerEntityId={readUuid(values?.customerEntityId)}
                value={typeof value === 'string' ? value : ''}
                onChange={setValue}
              />
            ),
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
            description: t(
              'offer_generator.create.currencyCode.description',
              'Three-letter code, for example PLN. Leave empty to use the default from settings.',
            ),
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
  }, [canGenerate, t])

  const handleSubmit = React.useCallback(
    async (values: CreateFormValues) => {
      const prompt = values.prompt?.trim() ?? ''
      const generateNow = canGenerate && values.generateNow === true
      if (generateNow && prompt.length < MIN_GENERATE_PROMPT_LENGTH) {
        const message = t(
          'offer_generator.create.errors.promptTooShort',
          'Write a brief of at least {min} characters to generate the offer.',
          { min: MIN_GENERATE_PROMPT_LENGTH },
        )
        throw createCrudFormError(message, { prompt: message })
      }
      const customerKind = values.customerEntityId ? values.customerKind : null
      const body = {
        title: values.title,
        clientName: values.clientName,
        customerKind,
        customerEntityId: customerKind ? values.customerEntityId : null,
        dealId: values.dealId,
        language: values.language,
        prompt: prompt || null,
        valueAmount: values.valueAmount,
        currencyCode: values.currencyCode,
        validUntil: values.validUntil,
      }
      const call = await createCrud<OfferCreateResponse>('offer_generator/offers', body, {
        errorMessage: t('offer_generator.create.errors.save', 'Failed to create the offer.'),
      })
      const offerId = call.result?.id ?? null
      flash(t('offer_generator.create.saved', 'Offer created.'), 'success')
      if (!offerId) {
        router.push(LIST_HREF)
        return
      }
      if (generateNow) {
        const generationPayload = { kind: 'generate' as const, prompt, language: values.language }
        const generation = await runMutation({
          operation: () =>
            apiCall<GenerationStartResponse>(
              `/api/offer_generator/offers/${encodeURIComponent(offerId)}/generate`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(generationPayload),
              },
            ),
          context: {
            formId: GENERATE_MUTATION_CONTEXT_ID,
            resourceKind: 'offer_generator.offer',
            resourceId: offerId,
            retryLastMutation,
          },
          mutationPayload: generationPayload,
        }).catch(() => null)
        if (generation?.ok) {
          flash(t('offer_generator.create.generationStarted', 'Offer generation started.'), 'success')
        } else {
          flash(
            t('offer_generator.create.errors.generation', 'The offer was saved, but generation could not be started.'),
            'error',
          )
        }
      }
      router.push(`${LIST_HREF}/${encodeURIComponent(offerId)}`)
    },
    [canGenerate, retryLastMutation, router, runMutation, t],
  )

  return (
    <Page>
      <PageBody>
        {prefillReady ? (
          <CrudForm<CreateFormValues>
            title={t('offer_generator.create.title', 'New offer')}
            titleHeadingLevel={1}
            backHref={LIST_HREF}
            cancelHref={LIST_HREF}
            schema={createFormSchema}
            fields={[]}
            groups={groups}
            initialValues={initialValues}
            submitLabel={t('offer_generator.create.submit', 'Create offer')}
            onSubmit={handleSubmit}
          />
        ) : (
          <LoadingMessage label={t('offer_generator.create.loading', 'Loading customer...')} />
        )}
      </PageBody>
    </Page>
  )
}
