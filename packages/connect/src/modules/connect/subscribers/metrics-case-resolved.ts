import { handleResolved } from './metrics-case-lifecycle'

export const metadata = {
  event: 'connect.case.resolved',
  persistent: true,
  id: 'connect:metrics-case-resolved',
}

export default handleResolved
