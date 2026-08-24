import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CostPerContactReport } from '@open-mercato/connect/modules/connect_cost_reporting/components/CostPerContactReport.client'
import { loadCostPerContactInitialReport } from '@open-mercato/connect/modules/connect_cost_reporting/lib/page-report'

export default async function CostPerContactPage() {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromCookies()
  const now = new Date()
  const to = now.toISOString()
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString()
  const currencyCode = 'PLN'
  const tenantId = (auth?.tenantId as string | null) ?? null
  const organizationId = (auth?.orgId as string | null) ?? null
  const initialReport = tenantId && organizationId
    ? await loadCostPerContactInitialReport({
        container: await createRequestContainer(),
        userId: auth?.sub as string,
        tenantId,
        organizationId,
        from,
        to,
        currencyCode,
      })
    : null

  return (
    <Page>
      <PageHeader
        title={t('connect_cost_reporting.nav.title', 'Cost per contact')}
        description={t(
          'connect_cost_reporting.page.description',
          'Exact allocated cost divided by canonical root contacts. Split descendants never increase the denominator.',
        )}
      />
      <PageBody>
        <CostPerContactReport
          initialReport={initialReport}
          initialFrom={from}
          initialTo={to}
          initialCurrency={currencyCode}
        />
      </PageBody>
    </Page>
  )
}
