import { consumeSource } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.outbound.delivery_confirmed', persistent: true, id: 'connect_sla:delivery-confirmed' }
const handleDeliveryConfirmed = (payload: Record<string, unknown>, context: Parameters<typeof consumeSource>[1]) => consumeSource(payload, context, 'response')
export default handleDeliveryConfirmed
