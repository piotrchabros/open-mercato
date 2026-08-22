import { handleReopened } from './metrics-case-lifecycle'

export const metadata = {
  event: 'connect.case.reopened',
  persistent: true,
  id: 'connect:metrics-case-reopened',
}

export default handleReopened
