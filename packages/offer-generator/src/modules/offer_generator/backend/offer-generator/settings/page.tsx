'use client'

import * as React from 'react'
import { z } from 'zod'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { offerLanguageSchema, settingsUpsertSchema } from '../../../data/validators'
import type { SettingsDto } from '../../../components/types'

const LIST_HREF = '/backend/offer-generator'

function emptyToNull(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return value
}

const settingsFormSchema = settingsUpsertSchema
  .omit({ tenantId: true, organizationId: true })
  .extend({
    extraInstructions: z.preprocess(emptyToNull, z.string().max(20000).nullable()),
    defaultModel: z.preprocess(emptyToNull, z.string().trim().min(1).max(200).nullable()),
    updatedAt: z.string().nullable().optional(),
  })

type SettingsFormValues = z.infer<typeof settingsFormSchema>

export default function OfferGeneratorSettingsPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [settings, setSettings] = React.useState<SettingsDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setSettings(await readApiResultOrThrow<SettingsDto>('/api/offer_generator/settings'))
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load, scopeVersion])

  const groups = React.useMemo<CrudFormGroup[]>(() => {
    const languageOptions = offerLanguageSchema.options.map((language) => ({
      value: language,
      label: t(`offer_generator.languages.${language}`, language),
    }))
    return [
      {
        id: 'company',
        column: 1,
        title: t('offer_generator.settings.groups.company', 'Company and defaults'),
        fields: [
          {
            id: 'companyName',
            type: 'text',
            label: t('offer_generator.settings.companyName.label', 'Company name'),
            description: t(
              'offer_generator.settings.companyName.description',
              'The sender named in generated offers and on the public offer page.',
            ),
            maxLength: 200,
          },
          {
            id: 'defaultLanguage',
            type: 'select',
            label: t('offer_generator.settings.defaultLanguage.label', 'Default language'),
            options: languageOptions,
            required: true,
          },
          {
            id: 'defaultCurrency',
            type: 'text',
            label: t('offer_generator.settings.defaultCurrency.label', 'Default currency'),
            description: t(
              'offer_generator.settings.defaultCurrency.description',
              'Three-letter code used when an offer has no currency, for example PLN.',
            ),
            placeholder: 'PLN',
            maxLength: 3,
            required: true,
          },
        ],
      },
      {
        id: 'ai',
        column: 2,
        title: t('offer_generator.settings.groups.ai', 'AI model'),
        fields: [
          {
            id: 'defaultModel',
            type: 'text',
            label: t('offer_generator.settings.defaultModel.label', 'Default model'),
            description: t(
              'offer_generator.settings.defaultModel.description',
              'Model id such as google/gemini-2.5-pro. Leave empty to use the platform default.',
            ),
            maxLength: 200,
          },
          {
            id: 'alternateModels',
            type: 'tags',
            label: t('offer_generator.settings.alternateModels.label', 'Alternate models'),
            description: t(
              'offer_generator.settings.alternateModels.description',
              'Extra model ids users may pick when generating an offer.',
            ),
          },
          {
            id: 'extraInstructions',
            type: 'textarea',
            label: t('offer_generator.settings.extraInstructions.label', 'Extra instructions'),
            description: t(
              'offer_generator.settings.extraInstructions.description',
              'Added to every generation and refinement prompt, for example tone of voice or fixed terms.',
            ),
            rows: 6,
            maxLength: 20000,
          },
        ],
      },
      {
        id: 'template',
        column: 1,
        title: t('offer_generator.settings.groups.template', 'Offer template'),
        fields: [
          {
            id: 'templateHtml',
            type: 'textarea',
            label: t('offer_generator.settings.templateHtml.label', 'Template HTML'),
            description: t(
              'offer_generator.settings.templateHtml.description',
              'A complete HTML document the AI uses as the layout and style reference for every offer.',
            ),
            rows: 24,
            required: true,
          },
        ],
      },
    ]
  }, [t])

  const initialValues = React.useMemo<Partial<SettingsFormValues> | undefined>(
    () =>
      settings
        ? {
            companyName: settings.companyName,
            templateHtml: settings.templateHtml,
            extraInstructions: settings.extraInstructions,
            defaultLanguage: settings.defaultLanguage,
            defaultCurrency: settings.defaultCurrency,
            defaultModel: settings.defaultModel,
            alternateModels: settings.alternateModels,
            updatedAt: settings.updatedAt,
          }
        : undefined,
    [settings],
  )

  const handleSubmit = React.useCallback(
    async (values: SettingsFormValues) => {
      const body = {
        companyName: values.companyName,
        templateHtml: values.templateHtml,
        extraInstructions: values.extraInstructions,
        defaultLanguage: values.defaultLanguage,
        defaultCurrency: values.defaultCurrency,
        defaultModel: values.defaultModel,
        alternateModels: values.alternateModels,
      }
      const call = await updateCrud<SettingsDto>('offer_generator/settings', body, {
        errorMessage: t('offer_generator.settings.saveError', 'Failed to save settings.'),
      })
      flash(t('offer_generator.settings.saved', 'Settings saved.'), 'success')
      if (call.result) setSettings(call.result)
      else await load()
    },
    [load, t],
  )

  return (
    <Page>
      <PageBody>
        {loading && !settings ? (
          <LoadingMessage label={t('offer_generator.settings.loading', 'Loading settings...')} />
        ) : failed || !initialValues ? (
          <ErrorMessage label={t('offer_generator.settings.loadError', 'Failed to load settings.')} />
        ) : (
          <CrudForm<SettingsFormValues>
            key={settings?.updatedAt ?? 'new'}
            title={t('offer_generator.settings.title', 'Offer generator settings')}
            titleHeadingLevel={1}
            backHref={LIST_HREF}
            cancelHref={LIST_HREF}
            fields={[]}
            groups={groups}
            initialValues={initialValues}
            schema={settingsFormSchema}
            submitLabel={t('offer_generator.settings.save', 'Save')}
            onSubmit={handleSubmit}
          />
        )}
      </PageBody>
    </Page>
  )
}
