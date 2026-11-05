import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const crmOffersTab = {
  widgetId: 'offer_generator.injection.crm-offers',
  kind: 'tab' as const,
  groupLabel: 'offer_generator.widgets.crmOffers.tab',
  priority: 55,
}

export const injectionTable: ModuleInjectionTable = {
  'detail:customers.person:tabs': [crmOffersTab],
  'detail:customers.company:tabs': [crmOffersTab],
  'detail:customers.deal:tabs': [crmOffersTab],
}

export default injectionTable
