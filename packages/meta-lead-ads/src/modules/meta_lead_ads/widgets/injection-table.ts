import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'
import { buildIntegrationDetailWidgetSpotId } from '@open-mercato/shared/modules/integrations/types'

export const injectionTable: ModuleInjectionTable = {
  [buildIntegrationDetailWidgetSpotId('meta_lead_ads')]: [
    {
      widgetId: 'meta_lead_ads.injection.integration-detail',
      priority: 100,
    },
  ],
  'detail:customers.person:tabs': [
    {
      widgetId: 'meta_lead_ads.injection.person-submissions',
      kind: 'tab',
      groupLabel: 'meta_lead_ads.widgets.personSubmissions.tab',
      priority: 60,
    },
  ],
}

export default injectionTable
