import { handleDisposed } from './metrics-inbound'

/**
 * Terminal inbound dispositions.
 *
 * A separate registration from the claim subscriber on purpose: auto-discovery
 * binds one handler per event, and keeping them independent means a retry storm
 * on one half never stalls the other.
 */
export const metadata = {
  event: 'connect.inbound.disposed',
  persistent: true,
  id: 'connect:metrics-inbound-disposed',
}

export default handleDisposed
