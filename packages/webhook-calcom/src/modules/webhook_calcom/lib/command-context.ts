import type { AwilixContainer } from 'awilix'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { CALCOM_INTEGRATION_ID } from '../integration'

export function buildCalcomCommandContext(container: AwilixContainer, scope: IntegrationScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    syncOrigin: CALCOM_INTEGRATION_ID,
  }
}
