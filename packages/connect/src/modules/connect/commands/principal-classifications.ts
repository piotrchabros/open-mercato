import { createHash } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler, type CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import {
  ConnectPrincipalClassification,
  ConnectPrincipalClassificationChange,
} from '../data/entities'
import {
  ensureConnectPrincipalClassificationInputSchema,
  undoConnectPrincipalClassificationInputSchema,
  type EnsureConnectPrincipalClassificationInput,
  type EnsureConnectPrincipalClassificationResult,
  type UndoConnectPrincipalClassificationInput,
  type UndoConnectPrincipalClassificationResult,
} from '../lib/principal-classification-provisioning'

type AuthPrincipalService = {
  principalExists(input: {
    type: 'user'
    id: string
    scope: { tenantId: string; organizationId: string }
  }): Promise<boolean>
}

function requireSystemActor(ctx: CommandRuntimeContext): void {
  if (ctx.systemActor !== true || ctx.auth !== null) {
    throw new Error('[internal] connect_principal_system_actor_required')
  }
}

function resolveAuthPrincipalService(ctx: CommandRuntimeContext): AuthPrincipalService {
  try {
    const candidate = ctx.container.resolve<unknown>('authPrincipalService')
    if (!candidate || typeof candidate !== 'object') throw new Error()
    if (typeof (candidate as { principalExists?: unknown }).principalExists !== 'function') throw new Error()
    return candidate as AuthPrincipalService
  } catch {
    throw new Error('[internal] connect_principal_target_unavailable')
  }
}

const FINGERPRINT_EXCLUDED_KEYS = new Set(['expectedUpdatedAt'])

function operationFingerprint(value: Record<string, unknown>): string {
  const canonical = Object.keys(value)
    .filter((key) => !FINGERPRINT_EXCLUDED_KEYS.has(key) && value[key] !== undefined)
    .sort()
    .map((key) => [key, value[key]])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

async function acquireOperationLock(
  em: EntityManager,
  input: { tenantId: string; organizationId: string; source: string; operationId: string },
): Promise<void> {
  await em.execute(`set local lock_timeout = '5s'`)
  await em.execute(
    'select pg_advisory_xact_lock(hashtextextended(?, 0))',
    [`connect-principal-classification:${input.tenantId}:${input.organizationId}:${input.source}:${input.operationId}`],
  )
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { code?: unknown; driverException?: { code?: unknown } }
  return record.code === '23505' || record.driverException?.code === '23505'
}

async function validatePrincipal(
  service: AuthPrincipalService,
  input: { tenantId: string; organizationId: string; userId: string },
): Promise<void> {
  try {
    const exists = await service.principalExists({
      type: 'user',
      id: input.userId,
      scope: { tenantId: input.tenantId, organizationId: input.organizationId },
    })
    if (!exists) throw new Error()
  } catch {
    throw new Error('[internal] connect_principal_target_unavailable')
  }
}

function ensureReplayResult(
  change: ConnectPrincipalClassificationChange,
): EnsureConnectPrincipalClassificationResult {
  if (!change.afterKind || !change.resultUpdatedAt) {
    throw new Error('[internal] connect_principal_operation_conflict')
  }
  return {
    classificationId: change.classificationId,
    userId: change.userId,
    kind: change.afterKind,
    created: change.createdClassification,
    changed: change.changedClassification,
    replayed: true,
    updatedAt: change.resultUpdatedAt.toISOString(),
  }
}

async function executeEnsure(
  rawInput: EnsureConnectPrincipalClassificationInput,
  ctx: CommandRuntimeContext,
): Promise<EnsureConnectPrincipalClassificationResult> {
  requireSystemActor(ctx)
  const input = ensureConnectPrincipalClassificationInputSchema.parse(rawInput)
  const requestFingerprint = operationFingerprint(input)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rootEm = (ctx.container.resolve<EntityManager>('em')).fork()
    try {
      return await rootEm.transactional(async (transactionalEm) => {
        const em = transactionalEm as EntityManager
        await acquireOperationLock(em, input)
        const existingChange = await em.findOne(ConnectPrincipalClassificationChange, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          source: input.source,
          operationId: input.operationId,
        })
        if (existingChange) {
          if (existingChange.requestFingerprint !== requestFingerprint || existingChange.tombstonedClassification) {
            throw new Error('[internal] connect_principal_operation_conflict')
          }
          return ensureReplayResult(existingChange)
        }

        await validatePrincipal(resolveAuthPrincipalService(ctx), input)
        let classification = await em.findOne(ConnectPrincipalClassification, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          userId: input.userId,
        }, { lockMode: LockMode.PESSIMISTIC_WRITE })
        const beforeKind = classification?.kind ?? null
        const created = !classification
        const changed = classification ? beforeKind !== input.kind : false

        if (!classification) {
          classification = em.create(ConnectPrincipalClassification, {
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            userId: input.userId,
            kind: input.kind,
          })
          em.persist(classification)
        } else if (changed) {
          if (!input.expectedUpdatedAt) {
            throw new Error('[internal] connect_principal_expected_version_required')
          }
          enforceCommandOptimisticLock({
            resourceKind: 'connect.principal_classification',
            resourceId: classification.id,
            expected: input.expectedUpdatedAt,
            current: classification.updatedAt,
          })
          classification.kind = input.kind
        }

        await em.flush()
        const result: EnsureConnectPrincipalClassificationResult = {
          classificationId: classification.id,
          userId: classification.userId,
          kind: classification.kind,
          created,
          changed,
          replayed: false,
          updatedAt: classification.updatedAt.toISOString(),
        }
        em.persist(em.create(ConnectPrincipalClassificationChange, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          operationId: input.operationId,
          source: input.source,
          requestFingerprint,
          classificationId: classification.id,
          userId: classification.userId,
          beforeKind,
          afterKind: classification.kind,
          createdClassification: created,
          changedClassification: changed,
          tombstonedClassification: false,
          resultUpdatedAt: classification.updatedAt,
          outcome: 'completed',
          reasonCode: input.reasonCode,
          referenceId: input.referenceId ?? null,
          inverseOfId: null,
        }))
        await em.flush()
        return result
      })
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue
      throw error
    }
  }
  throw new Error('[internal] connect_principal_operation_conflict')
}

function undoReplayResult(change: ConnectPrincipalClassificationChange): UndoConnectPrincipalClassificationResult {
  return {
    classificationId: change.classificationId,
    userId: change.userId,
    kind: change.afterKind ?? null,
    tombstoned: change.tombstonedClassification,
    replayed: true,
    updatedAt: change.resultUpdatedAt?.toISOString() ?? null,
  }
}

async function executeUndo(
  rawInput: UndoConnectPrincipalClassificationInput,
  ctx: CommandRuntimeContext,
): Promise<UndoConnectPrincipalClassificationResult> {
  requireSystemActor(ctx)
  const input = undoConnectPrincipalClassificationInputSchema.parse(rawInput)
  const requestFingerprint = operationFingerprint(input)
  const rootEm = ctx.container.resolve<EntityManager>('em').fork()
  return rootEm.transactional(async (transactionalEm) => {
    const em = transactionalEm as EntityManager
    await acquireOperationLock(em, input)
    const replay = await em.findOne(ConnectPrincipalClassificationChange, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      source: input.source,
      operationId: input.operationId,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint || !replay.inverseOfId) {
        throw new Error('[internal] connect_principal_operation_conflict')
      }
      return undoReplayResult(replay)
    }

    const original = await em.findOne(ConnectPrincipalClassificationChange, {
      id: input.originalChangeId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      outcome: 'completed',
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (!original || (!original.createdClassification && !original.changedClassification)) {
      throw new Error('[internal] connect_principal_undo_conflict')
    }
    const laterChange = await em.findOne(ConnectPrincipalClassificationChange, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      userId: original.userId,
      createdAt: { $gt: original.createdAt },
    })
    const classification = await em.findOne(ConnectPrincipalClassification, {
      id: original.classificationId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      userId: original.userId,
    }, { lockMode: LockMode.PESSIMISTIC_WRITE })
    if (laterChange || !classification || classification.kind !== original.afterKind) {
      throw new Error('[internal] connect_principal_undo_conflict')
    }
    enforceCommandOptimisticLock({
      resourceKind: 'connect.principal_classification',
      resourceId: classification.id,
      expected: input.expectedUpdatedAt,
      current: classification.updatedAt,
    })

    let resultUpdatedAt: Date | null = null
    let afterKind = original.beforeKind ?? null
    const tombstoned = original.createdClassification
    if (tombstoned) {
      em.remove(classification)
    } else {
      if (!afterKind) throw new Error('[internal] connect_principal_undo_conflict')
      classification.kind = afterKind
      await em.flush()
      resultUpdatedAt = classification.updatedAt
    }
    original.outcome = 'undone'
    em.persist(em.create(ConnectPrincipalClassificationChange, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      operationId: input.operationId,
      source: input.source,
      requestFingerprint,
      classificationId: original.classificationId,
      userId: original.userId,
      beforeKind: original.afterKind,
      afterKind,
      createdClassification: false,
      changedClassification: true,
      tombstonedClassification: tombstoned,
      resultUpdatedAt,
      outcome: 'completed',
      reasonCode: input.reasonCode,
      referenceId: null,
      inverseOfId: original.id,
    }))
    await em.flush()
    return {
      classificationId: original.classificationId,
      userId: original.userId,
      kind: afterKind,
      tombstoned,
      replayed: false,
      updatedAt: resultUpdatedAt?.toISOString() ?? null,
    }
  })
}

export const ensureConnectPrincipalClassificationCommand: CommandHandler<
  EnsureConnectPrincipalClassificationInput,
  EnsureConnectPrincipalClassificationResult
> = {
  id: 'connect.principal_classification.ensure',
  execute: executeEnsure,
  buildLog: () => ({ skipLog: true }),
}

export const undoConnectPrincipalClassificationCommand: CommandHandler<
  UndoConnectPrincipalClassificationInput,
  UndoConnectPrincipalClassificationResult
> = {
  id: 'connect.principal_classification.undo',
  execute: executeUndo,
  buildLog: () => ({ skipLog: true }),
}

registerCommand(ensureConnectPrincipalClassificationCommand)
registerCommand(undoConnectPrincipalClassificationCommand)
