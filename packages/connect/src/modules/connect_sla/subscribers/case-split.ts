import { consumeReparent } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.split', persistent: true, id: 'connect_sla:case-split' }
const handleCaseSplit = (payload: Record<string, unknown>, context: Parameters<typeof consumeReparent>[1]) => consumeReparent(payload, context, 'split')
export default handleCaseSplit
