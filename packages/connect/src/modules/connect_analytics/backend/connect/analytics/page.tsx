import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  OperationalReportClient,
  defaultOperationalRange,
  type OperationalReportFailure,
} from '@open-mercato/connect/modules/connect_analytics/components/OperationalReport.client'
import { loadOperationalReport } from '@open-mercato/connect/modules/connect_analytics/lib/load-operational-report'
import {
  shiftUtcDate,
  utcToday,
  type OperationalReport,
} from '@open-mercato/connect/modules/connect_analytics/lib/report-composer'

/**
 * Server shell for the read-only analytics screen.
 *
 * The first range is composed here rather than fetched from the browser, so the
 * page is useful before hydration and the report a screen reader announces is
 * the same one a sighted reader sees. The client island exists only to change
 * the range.
 */

export default async function ConnectAnalyticsRoute() {
  const { t } = await resolveTranslations()
  const auth = await getAuthFromCookies()
  const tenantId = (auth?.tenantId as string | null) ?? null
  const organizationId = (auth?.orgId as string | null) ?? null
  const todayUtc = utcToday()
  const range = defaultOperationalRange(todayUtc)

  let report: OperationalReport | null = null
  let failure: OperationalReportFailure | null = null

  if (tenantId && organizationId) {
    try {
      const container = await createRequestContainer()
      const loaded = await loadOperationalReport({
        container,
        tenantId,
        organizationId,
        from: range.from,
        to: range.to,
        todayUtc,
      })
      if (loaded.status === 'ok') report = loaded.report
      else failure = loaded.status === 'unavailable' ? 'unavailable' : 'load'
    } catch {
      // Fail visible, not silent: the island renders the error state and the
      // reader is never shown zeroes that were never measured.
      failure = 'load'
    }
  } else {
    failure = 'load'
  }

  return (
    <Page>
      <PageHeader
        title={t('connect_analytics.nav.title', 'Connect analytics')}
        description={t(
          'connect_analytics.page.description',
          'Read-only operational reporting over complete UTC days. Rebuilding aggregates stays on the Connect metrics page.',
        )}
      />
      <PageBody>
        <OperationalReportClient
          initialReport={report}
          initialFailure={failure}
          initialFrom={range.from}
          initialTo={range.to}
          maxDate={shiftUtcDate(todayUtc, -1)}
        />
      </PageBody>
    </Page>
  )
}
