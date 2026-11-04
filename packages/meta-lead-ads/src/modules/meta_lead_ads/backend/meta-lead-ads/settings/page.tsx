'use client'

import * as React from 'react'
import { z } from 'zod'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { settingsSchema, type SettingsInput } from '../../../data/validators'
import type { SettingsDto } from '../../../components/types'

const settingsFormSchema = settingsSchema.extend({ updatedAt: z.string().nullable().optional() })

type SettingsFormValues = z.infer<typeof settingsFormSchema>

export default function MetaLeadAdsSettingsPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload } = useBackendChrome()
  const canManage = React.useMemo(
    () => hasFeature(payload?.grantedFeatures ?? [], 'meta_lead_ads.manage'),
    [payload?.grantedFeatures],
  )
  const [settings, setSettings] = React.useState<SettingsDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const dto = await readApiResultOrThrow<SettingsDto>('/api/meta_lead_ads/settings')
      setSettings(dto)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load, scopeVersion])

  const fields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'retentionDays',
        type: 'number',
        label: t('meta_lead_ads.settings.retentionDays.label', 'Raw lead retention (days)'),
        description: t(
          'meta_lead_ads.settings.retentionDays.description',
          'Raw lead payloads are purged after this many days (1 to 365).',
        ),
        required: true,
        readOnly: !canManage,
      },
      {
        id: 'defaultCountry',
        type: 'text',
        label: t('meta_lead_ads.settings.defaultCountry.label', 'Default phone country'),
        description: t(
          'meta_lead_ads.settings.defaultCountry.description',
          'Two-letter ISO country code used to normalize phone numbers without a prefix, for example PL.',
        ),
        placeholder: 'PL',
        required: true,
        readOnly: !canManage,
      },
    ],
    [canManage, t],
  )

  const initialValues = React.useMemo<Partial<SettingsFormValues> | undefined>(
    () =>
      settings
        ? {
            retentionDays: settings.retentionDays,
            defaultCountry: settings.defaultCountry,
            updatedAt: settings.updatedAt,
          }
        : undefined,
    [settings],
  )

  const handleSubmit = React.useCallback(
    async (values: SettingsFormValues) => {
      const body: SettingsInput = {
        retentionDays: Number(values.retentionDays),
        defaultCountry: String(values.defaultCountry ?? '').trim().toUpperCase(),
      }
      await updateCrud<SettingsDto>('meta_lead_ads/settings', body, {
        errorMessage: t('meta_lead_ads.settings.saveError', 'Failed to save settings.'),
      })
      flash(t('meta_lead_ads.settings.saved', 'Settings saved.'), 'success')
      await load()
    },
    [load, t],
  )

  return (
    <Page>
      <PageBody>
        {loading && !settings ? (
          <LoadingMessage label={t('meta_lead_ads.settings.loading', 'Loading settings...')} />
        ) : failed || !initialValues ? (
          <ErrorMessage label={t('meta_lead_ads.settings.loadError', 'Failed to load settings.')} />
        ) : (
          <CrudForm<SettingsFormValues>
            key={settings?.updatedAt ?? 'new'}
            title={t('meta_lead_ads.settings.title', 'Meta Lead Ads settings')}
            backHref="/backend/meta-lead-ads"
            fields={fields}
            initialValues={initialValues}
            schema={settingsFormSchema}
            readOnly={!canManage}
            hideFooterActions={!canManage}
            submitLabel={t('meta_lead_ads.settings.save', 'Save')}
            onSubmit={handleSubmit}
          />
        )}
      </PageBody>
    </Page>
  )
}
