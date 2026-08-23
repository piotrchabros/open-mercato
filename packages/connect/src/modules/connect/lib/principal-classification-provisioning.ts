import type { AwilixContainer } from 'awilix'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { z } from 'zod'
import { CONNECT_PRINCIPAL_KINDS, type ConnectPrincipalKind } from './principal-classification'

const tokenSchema = z.string().regex(/^[a-z0-9._:-]{1,100}$/)

export const ensureConnectPrincipalClassificationInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(CONNECT_PRINCIPAL_KINDS),
  source: tokenSchema,
  reasonCode: tokenSchema,
  referenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
}).strict()

export type EnsureConnectPrincipalClassificationInput =
  z.infer<typeof ensureConnectPrincipalClassificationInputSchema>

export type EnsureConnectPrincipalClassificationResult = {
  classificationId: string
  userId: string
  kind: ConnectPrincipalKind
  created: boolean
  changed: boolean
  replayed: boolean
  updatedAt: string
}

export const undoConnectPrincipalClassificationInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  source: tokenSchema,
  originalChangeId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  reasonCode: tokenSchema,
}).strict()

export type UndoConnectPrincipalClassificationInput =
  z.infer<typeof undoConnectPrincipalClassificationInputSchema>

export type UndoConnectPrincipalClassificationResult = {
  classificationId: string
  userId: string
  kind: ConnectPrincipalKind | null
  tombstoned: boolean
  replayed: boolean
  updatedAt: string | null
}

export interface ConnectPrincipalClassificationProvisioningService {
  ensure(input: EnsureConnectPrincipalClassificationInput): Promise<EnsureConnectPrincipalClassificationResult>
  undo(input: UndoConnectPrincipalClassificationInput): Promise<UndoConnectPrincipalClassificationResult>
}

export function createConnectPrincipalClassificationProvisioningService(
  container: AwilixContainer,
): ConnectPrincipalClassificationProvisioningService {
  const execute = async <TInput, TResult>(commandId: string, input: TInput): Promise<TResult> => {
    const commandBus = container.resolve<CommandBus>('commandBus')
    const execution = await commandBus.execute<TInput, TResult>(commandId, {
      input,
      ctx: {
        container,
        auth: null,
        organizationScope: null,
        selectedOrganizationId: null,
        organizationIds: null,
        systemActor: true,
      },
    })
    return execution.result
  }

  return {
    ensure: (input) => execute('connect.principal_classification.ensure', input),
    undo: (input) => execute('connect.principal_classification.undo', input),
  }
}
