import { consumeReparent } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.merged', persistent: true, id: 'connect_sla:case-merged' }
const handleCaseMerged = (payload: Record<string, unknown>, context: Parameters<typeof consumeReparent>[1]) => consumeReparent(payload, context, 'merged')
export default handleCaseMerged
