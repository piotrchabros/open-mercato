import dynamic from 'next/dynamic'
import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'

const ConnectCustomerCasesWidget = dynamic(() => import('./widget.client'))

const widget: InjectionWidgetModule<Record<string, unknown>, Record<string, unknown>> = {
  metadata: {
    id: 'connect.injection.customer-cases',
    title: 'Connect conversations',
    description: 'Summarises the customer’s Connect conversations on their detail page.',
    features: ['connect.customer_match.read'],
    requiredModules: ['customers'],
    priority: 60,
    enabled: true,
  },
  Widget: ConnectCustomerCasesWidget,
}

export default widget
