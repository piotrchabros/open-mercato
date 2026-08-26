import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ReportResponse } from '../data/validators'
import { loadCostPerContactReport } from './load-report'

type RbacServiceLike = {
  userHasAllFeatures: (
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

export async function loadCostPerContactInitialReport(input: {
  container: AppContainer
  userId: string
  tenantId: string
  organizationId: string
  from: string
  to: string
  currencyCode: string
}): Promise<ReportResponse | null> {
  try {
    const rbac = input.container.resolve('rbacService') as RbacServiceLike
    const financialAuthorized = await rbac.userHasAllFeatures(
      input.userId,
      ['connect_analytics.cost_inputs.view'],
      { tenantId: input.tenantId, organizationId: input.organizationId },
    )
    return await loadCostPerContactReport({ ...input, financialAuthorized })
  } catch {
    return null
  }
}
