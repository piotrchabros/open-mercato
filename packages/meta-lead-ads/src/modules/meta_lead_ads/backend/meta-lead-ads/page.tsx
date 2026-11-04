"use client"

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { ConnectionsSection } from '../../components/ConnectionsSection'
import { PagesSection } from '../../components/PagesSection'
import { SyncRunsSection } from '../../components/SyncRunsSection'
import { BackfillDialog } from '../../components/BackfillDialog'

type FeatureCheckResponse = { granted?: string[] }

const CONNECT_OK = 'ok'

function useManageAccess(): boolean {
  const [granted, setGranted] = React.useState<string[]>([])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const call = await apiCall<FeatureCheckResponse>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: ['meta_lead_ads.manage'] }),
        })
        if (!cancelled) setGranted(Array.isArray(call.result?.granted) ? call.result.granted : [])
      } catch {
        if (!cancelled) setGranted([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return hasFeature(granted, 'meta_lead_ads.manage')
}

export default function MetaLeadAdsPage() {
  const t = useT()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const canManage = useManageAccess()
  const [backfillOpen, setBackfillOpen] = React.useState(false)
  const [refreshToken, setRefreshToken] = React.useState(0)

  const connectResult = searchParams?.get('connect') ?? null

  React.useEffect(() => {
    if (!connectResult) return
    if (connectResult === CONNECT_OK) {
      flash(t('meta_lead_ads.connect.success'), 'success')
    } else {
      flash(t(`meta_lead_ads.connect.errors.${connectResult}`, t('meta_lead_ads.connect.errors.unknown')), 'error')
    }
    router.replace(pathname ?? '/backend/meta-lead-ads')
  }, [connectResult, pathname, router, t])

  const handleBackfillStarted = React.useCallback(() => {
    setRefreshToken((value) => value + 1)
  }, [])

  return (
    <Page>
      <PageBody className="space-y-6">
        <PageHeader
          title={t('meta_lead_ads.page.title')}
          description={t('meta_lead_ads.page.description')}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline">
                <Link href="/backend/meta-lead-ads/leads">{t('meta_lead_ads.page.leadsLogLink')}</Link>
              </Button>
              {canManage ? (
                <Button asChild variant="outline">
                  <Link href="/backend/meta-lead-ads/settings">{t('meta_lead_ads.page.settingsLink')}</Link>
                </Button>
              ) : null}
              {canManage ? (
                <Button type="button" onClick={() => setBackfillOpen(true)}>
                  {t('meta_lead_ads.page.backfill')}
                </Button>
              ) : null}
            </div>
          )}
        />
        <ConnectionsSection canManage={canManage} />
        <PagesSection canManage={canManage} />
        <SyncRunsSection refreshToken={refreshToken} />
        {canManage ? (
          <BackfillDialog
            open={backfillOpen}
            onOpenChange={setBackfillOpen}
            onStarted={handleBackfillStarted}
          />
        ) : null}
      </PageBody>
    </Page>
  )
}
