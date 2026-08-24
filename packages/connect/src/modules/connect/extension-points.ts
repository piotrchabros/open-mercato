import {
  defineModuleExtensionPoints,
  injectionExtensionHost,
} from '@open-mercato/shared/modules/widgets/extension-points'

export const extensionPoints = defineModuleExtensionPoints({
  moduleId: 'connect',
  hosts: {
    inboxCaseDetailSla: injectionExtensionHost({
      family: 'detail',
      spotId: 'connect:inbox:case-detail:sla',
      supported: ['render-widget'],
      source: 'components/inbox/ConnectInboxPage.tsx',
    }),
  },
})

export default extensionPoints
