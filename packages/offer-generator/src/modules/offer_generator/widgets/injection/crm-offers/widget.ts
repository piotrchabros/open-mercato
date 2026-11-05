import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CrmOffersWidget from './widget.client'

type CrmOffersContext = {
  resourceKind: string
  resourceId: string
}

const widget: InjectionWidgetModule<CrmOffersContext, unknown> = {
  metadata: {
    id: 'offer_generator.injection.crm-offers',
    title: 'Offers',
    description: 'Offers linked to the current person, company or deal',
    features: ['offer_generator.view'],
    priority: 55,
    enabled: true,
  },
  Widget: CrmOffersWidget,
}

export default widget
