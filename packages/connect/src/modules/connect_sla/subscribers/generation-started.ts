import { consumeGeneration } from '../lib/subscriber-handler'
export const metadata = { event: 'connect.case.generation_started', persistent: true, id: 'connect_sla:generation-started' }
const handleGenerationStarted = (payload: Record<string, unknown>, context: Parameters<typeof consumeGeneration>[1]) => consumeGeneration(payload, context)
export default handleGenerationStarted
