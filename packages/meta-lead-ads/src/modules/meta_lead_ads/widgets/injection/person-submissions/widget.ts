import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PersonSubmissionsWidget from './widget.client'

type PersonSubmissionsContext = {
  resourceKind: string
  resourceId: string
}

const widget: InjectionWidgetModule<PersonSubmissionsContext, unknown> = {
  metadata: {
    id: 'meta_lead_ads.injection.person-submissions',
    title: 'Lead form submissions',
    description: 'Meta Lead Ads submissions and consents for the current person',
    features: ['meta_lead_ads.view_logs'],
    priority: 60,
    enabled: true,
  },
  Widget: PersonSubmissionsWidget,
}

export default widget
