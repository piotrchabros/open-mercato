import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { InboundEndpointConfigEntity } from '../data/entities'

export type UpsertInboundEndpointConfigInput = {
  sourceKey: string
  integrationId: string | null
  scope: { tenantId: string; organizationId: string }
  isActive: boolean
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

async function findConfig(
  em: EntityManager,
  input: UpsertInboundEndpointConfigInput,
): Promise<InboundEndpointConfigEntity | null> {
  return findOneWithDecryption(
    em,
    InboundEndpointConfigEntity,
    {
      sourceKey: input.sourceKey,
      organizationId: input.scope.organizationId,
      tenantId: input.scope.tenantId,
    },
    undefined,
    { tenantId: input.scope.tenantId, organizationId: input.scope.organizationId },
  )
}

async function updateConfig(
  em: EntityManager,
  config: InboundEndpointConfigEntity,
  input: UpsertInboundEndpointConfigInput,
): Promise<string> {
  config.isActive = input.isActive
  config.integrationId = input.integrationId
  await em.flush()
  return config.id
}

export async function upsertInboundEndpointConfig(
  em: EntityManager,
  input: UpsertInboundEndpointConfigInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await findConfig(em, input)
  if (existing) return { id: await updateConfig(em, existing, input), created: false }

  const config = em.create(InboundEndpointConfigEntity, {
    sourceKey: input.sourceKey,
    isActive: input.isActive,
    integrationId: input.integrationId,
    organizationId: input.scope.organizationId,
    tenantId: input.scope.tenantId,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  try {
    await em.flush()
    return { id: config.id, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const freshEm = em.fork()
    const raced = await findConfig(freshEm, input)
    if (!raced) throw error
    return { id: await updateConfig(freshEm, raced, input), created: false }
  }
}
