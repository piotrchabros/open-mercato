import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import IntegrationDetailWidget from './widget.client'

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'meta_lead_ads.injection.integration-detail',
    title: 'Meta Lead Ads',
    description: 'Quick links to the Meta Lead Ads connections, lead log and settings.',
    features: ['meta_lead_ads.view_logs'],
    priority: 100,
    enabled: true,
  },
  Widget: IntegrationDetailWidget,
}

export default widget
