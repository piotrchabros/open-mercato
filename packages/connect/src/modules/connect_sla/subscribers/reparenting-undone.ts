import { consumeReparent } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.reparenting_undone', persistent: true, id: 'connect_sla:reparenting-undone' }
const handleReparentingUndone = (payload: Record<string, unknown>, context: Parameters<typeof consumeReparent>[1]) => consumeReparent(payload, context, 'reparenting_undone')
export default handleReparentingUndone
