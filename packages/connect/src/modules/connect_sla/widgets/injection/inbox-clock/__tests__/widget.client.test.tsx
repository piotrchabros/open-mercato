import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import ConnectSlaInboxClockWidget, { buildInboxClockUrl } from '../widget.client'
import type { ConnectSlaInboxContext } from '../widget'
import { injectionTable } from '../../../injection-table'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string) => key,
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => React.createElement('div', null, label),
  ErrorMessage: ({ label }: { label: string }) => React.createElement('div', null, label),
}))

function render(context: ConnectSlaInboxContext): string {
  return renderToStaticMarkup(
    React.createElement(ConnectSlaInboxClockWidget, {
      context,
      data: {},
      onDataChange: () => undefined,
      disabled: false,
    } satisfies InjectionWidgetComponentProps<ConnectSlaInboxContext, Record<string, unknown>>),
  )
}

describe('Connect SLA Inbox clock widget', () => {
  it('maps the widget to the frozen Connect Inbox host', () => {
    expect(injectionTable['connect:inbox:case-detail:sla']).toEqual({
      widgetId: 'connect_sla.injection.inbox-clock',
      priority: 100,
    })
  })

  it('builds the scoped case clock request URL', () => {
    expect(buildInboxClockUrl('case/one')).toBe('/api/connect-sla/clocks?caseId=case%2Fone')
  })

  it('stays inert without a case and renders its loading state for a selected case', () => {
    expect(render({})).toBe('')
    expect(render({ caseId: 'case-1' })).toContain('connect_sla.inbox.loading')
  })
})
