import { handleStatusChanged } from './metrics-outbound'

/**
 * Delivery-outcome facts. Registered separately from the attempt subscriber so
 * each event has its own retry lifecycle.
 */
export const metadata = {
  event: 'connect.outbound.status_changed',
  persistent: true,
  id: 'connect:metrics-outbound-status',
}

export default handleStatusChanged
