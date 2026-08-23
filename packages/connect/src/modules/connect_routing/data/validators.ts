import { z } from 'zod'

/**
 * Every entry point into reconciliation — the queue worker, the CLI, and module
 * setup — validates through this one schema. The payload arrives from trusted
 * internal callers, but "trusted" has never stopped a job from being redelivered
 * with a scope that no longer parses, and a malformed scope reaching the SQL
 * layer is exactly how a cross-organization write happens.
 */
export const reconcileCapacityPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
}).strict()

export type ReconcileCapacityPayload = z.infer<typeof reconcileCapacityPayloadSchema>
