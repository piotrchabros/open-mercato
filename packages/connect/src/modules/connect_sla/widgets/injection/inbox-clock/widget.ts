import dynamic from 'next/dynamic'
import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'

const InboxClockWidget = dynamic(() => import('./widget.client'))

export type ConnectSlaInboxContext = {
  caseId?: string
  retryLastMutation?: () => Promise<boolean | void> | boolean | void
}

const widget: InjectionWidgetModule<ConnectSlaInboxContext, Record<string, unknown>> = {
  metadata: {
    id: 'connect_sla.injection.inbox-clock',
    title: 'Connect SLA clock',
    description: 'Shows the current response and resolution deadlines for a Connect case.',
    features: ['connect_sla.clock.view'],
    requiredModules: ['connect'],
    priority: 100,
    enabled: true,
  },
  Widget: InboxClockWidget,
}

export default widget
