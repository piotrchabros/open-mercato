import { consumeSource } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.customer_wait_started', persistent: true, id: 'connect_sla:wait-started' }
const handleWaitStarted = (payload: Record<string, unknown>, context: Parameters<typeof consumeSource>[1]) => consumeSource(payload, context, 'wait_started')
export default handleWaitStarted
