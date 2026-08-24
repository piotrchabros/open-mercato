import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'connect:inbox:case-detail:sla': {
    widgetId: 'connect_sla.injection.inbox-clock',
    priority: 100,
  },
}

export default injectionTable
