import { consumeSource } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.customer_wait_ended', persistent: true, id: 'connect_sla:wait-ended' }
const handleWaitEnded = (payload: Record<string, unknown>, context: Parameters<typeof consumeSource>[1]) => consumeSource(payload, context, 'wait_ended')
export default handleWaitEnded
