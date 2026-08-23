import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import {
  ConnectPrincipalClassification,
  ConnectPrincipalClassificationChange,
  ConnectPrincipalClassificationManifestEntry,
} from '../data/entities'
import { CONNECT_PRINCIPAL_KINDS } from './principal-classification'
import type { ConnectPrincipalClassificationProvisioningService } from './principal-classification-provisioning'

const manifestEntrySchema = z.object({
  externalKey: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  userId: z.string().uuid(),
  kind: z.enum(CONNECT_PRINCIPAL_KINDS),
  reasonCode: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  referenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
}).strict()

export const connectPrincipalClassificationManifestSchema = z.object({
  entries: z.array(manifestEntrySchema).max(100),
}).strict().superRefine((manifest, ctx) => {
  const externalKeys = new Set<string>()
  const userIds = new Set<string>()
  for (const [index, entry] of manifest.entries.entries()) {
    if (externalKeys.has(entry.externalKey)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'externalKey'], message: 'duplicate externalKey' })
    }
    if (userIds.has(entry.userId)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'userId'], message: 'duplicate userId' })
    }
    externalKeys.add(entry.externalKey)
    userIds.add(entry.userId)
  }
})

export type ConnectPrincipalClassificationManifest =
  z.infer<typeof connectPrincipalClassificationManifestSchema>

export type ReconcileConnectPrincipalManifestInput = {
  tenantId: string
  organizationId: string
  manifest: ConnectPrincipalClassificationManifest
  apply: boolean
}

export type ReconcileConnectPrincipalManifestResult = {
  desired: number
  created: number
  updated: number
  unchanged: number
  retired: number
  reconciled: number
  unavailable: number
}

function deterministicOperationId(parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function operationIdFor(
  scope: { tenantId: string; organizationId: string },
  entry: ConnectPrincipalClassificationManifest['entries'][number],
  revision: number,
): string {
  return deterministicOperationId([
    scope.tenantId,
    scope.organizationId,
    entry.externalKey,
    entry.userId,
    entry.kind,
    entry.reasonCode,
    entry.referenceId ?? '',
    String(revision),
  ])
}

function hasDrifted(
  current: ConnectPrincipalClassificationManifestEntry,
  desired: ConnectPrincipalClassificationManifest['entries'][number],
): boolean {
  return current.userId !== desired.userId || current.kind !== desired.kind ||
    current.reasonCode !== desired.reasonCode || current.referenceId !== (desired.referenceId ?? null) ||
    !current.active
}

async function retireManifestEntry(
  dependencies: {
    em: EntityManager
    provisioningService: ConnectPrincipalClassificationProvisioningService
  },
  entry: ConnectPrincipalClassificationManifestEntry,
): Promise<boolean> {
  const change = await dependencies.em.findOne(ConnectPrincipalClassificationChange, {
    tenantId: entry.tenantId,
    organizationId: entry.organizationId,
    userId: entry.userId,
    outcome: 'completed',
    inverseOfId: null,
  }, { orderBy: { createdAt: 'desc' } })
  if (!change?.resultUpdatedAt) return false
  await dependencies.provisioningService.undo({
    tenantId: entry.tenantId,
    organizationId: entry.organizationId,
    operationId: deterministicOperationId([entry.operationId, 'retire']),
    source: 'connect.principal_manifest',
    originalChangeId: change.id,
    expectedUpdatedAt: change.resultUpdatedAt.toISOString(),
    reasonCode: 'manifest.retired',
  })
  entry.active = false
  entry.lastReconciledAt = new Date()
  entry.lastResultCode = 'retired'
  await dependencies.em.flush()
  return true
}

export function createConnectPrincipalClassificationManifestService(dependencies: {
  em: EntityManager
  provisioningService: ConnectPrincipalClassificationProvisioningService
}) {
  return {
    async reconcile(rawInput: ReconcileConnectPrincipalManifestInput): Promise<ReconcileConnectPrincipalManifestResult> {
      const scope = z.object({
        tenantId: z.string().uuid(),
        organizationId: z.string().uuid(),
      }).parse(rawInput)
      const manifest = connectPrincipalClassificationManifestSchema.parse(rawInput.manifest)
      const result: ReconcileConnectPrincipalManifestResult = {
        desired: manifest.entries.length,
        created: 0,
        updated: 0,
        unchanged: 0,
        retired: 0,
        reconciled: 0,
        unavailable: 0,
      }
      const existing = await dependencies.em.find(ConnectPrincipalClassificationManifestEntry, scope)
      const existingByKey = new Map(existing.map((entry) => [entry.externalKey, entry]))

      for (const desired of manifest.entries) {
        const current = existingByKey.get(desired.externalKey)
        const drifted = current ? hasDrifted(current, desired) : false
        if (!current) result.created += 1
        else if (drifted) result.updated += 1
        else result.unchanged += 1
        if (!rawInput.apply) continue

        if (!current) {
          dependencies.em.persist(dependencies.em.create(ConnectPrincipalClassificationManifestEntry, {
            ...scope,
            externalKey: desired.externalKey,
            userId: desired.userId,
            kind: desired.kind,
            reasonCode: desired.reasonCode,
            referenceId: desired.referenceId ?? null,
            revision: 1,
            operationId: operationIdFor(scope, desired, 1),
          }))
          continue
        }
        if (!drifted) continue
        current.revision += 1
        current.userId = desired.userId
        current.kind = desired.kind
        current.reasonCode = desired.reasonCode
        current.referenceId = desired.referenceId ?? null
        current.active = true
        current.operationId = operationIdFor(scope, desired, current.revision)
      }

      const desiredKeys = new Set(manifest.entries.map((entry) => entry.externalKey))
      const retirementEntries: ConnectPrincipalClassificationManifestEntry[] = []
      for (const entry of existing) {
        if (entry.active && !desiredKeys.has(entry.externalKey)) {
          result.retired += 1
          retirementEntries.push(entry)
        }
      }
      if (!rawInput.apply) return result
      await dependencies.em.flush()

      const activeEntries = (await dependencies.em.find(
        ConnectPrincipalClassificationManifestEntry,
        { ...scope, active: true },
        { orderBy: { externalKey: 'asc' } },
      )).filter((entry) => desiredKeys.has(entry.externalKey))
      for (const entry of activeEntries) {
        try {
          const classification = await dependencies.em.findOne(ConnectPrincipalClassification, {
            tenantId: entry.tenantId,
            organizationId: entry.organizationId,
            userId: entry.userId,
          })
          const ensured = await dependencies.provisioningService.ensure({
            ...scope,
            operationId: entry.operationId,
            userId: entry.userId,
            kind: entry.kind,
            source: 'connect.principal_manifest',
            reasonCode: entry.reasonCode,
            referenceId: entry.referenceId ?? undefined,
            expectedUpdatedAt: classification?.updatedAt.toISOString(),
          })
          entry.lastReconciledAt = new Date()
          entry.lastResultCode = ensured.replayed ? 'replayed' : ensured.changed ? 'changed' : 'unchanged'
          result.reconciled += 1
        } catch {
          entry.lastReconciledAt = new Date()
          entry.lastResultCode = 'target_unavailable'
          result.unavailable += 1
        }
      }
      for (const entry of retirementEntries) {
        try {
          if (!await retireManifestEntry(dependencies, entry)) result.unavailable += 1
        } catch {
          entry.lastReconciledAt = new Date()
          entry.lastResultCode = 'retirement_conflict'
          result.unavailable += 1
        }
      }
      await dependencies.em.flush()
      return result
    },

    async retire(entryId: string, expectedUpdatedAt: string): Promise<boolean> {
      const entry = await dependencies.em.findOne(
        ConnectPrincipalClassificationManifestEntry,
        { id: entryId },
      )
      if (!entry || !entry.active || entry.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
        return false
      }
      return retireManifestEntry(dependencies, entry)
    },
  }
}
