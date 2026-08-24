import { consumeSource } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.generation_resolved', persistent: true, id: 'connect_sla:generation-resolved' }
const handleGenerationResolved = (payload: Record<string, unknown>, context: Parameters<typeof consumeSource>[1]) => consumeSource(payload, context, 'resolved')
export default handleGenerationResolved
