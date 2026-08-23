import type { JobContext, QueuedJob } from '@open-mercato/queue'
import handle, { metadata } from '../reconcile-capacity'
import { CONNECT_ROUTING_QUEUES } from '../../lib/queue'
import { reconcileCapacityPayloadSchema } from '../../data/validators'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

function createContext(reconcile: jest.Mock): HandlerContext {
  return {
    resolve: <T = unknown>(name: string): T => {
      if (name !== 'connectRoutingCapacityService') throw new Error(`[internal] unknown registration ${name}`)
      return { reconcile } as T
    },
  } as HandlerContext
}

describe('connect routing capacity worker', () => {
  it('pins the queue name, worker id and concurrency', () => {
    // These three are a published contract: the setup deferral enqueues onto the
    // queue name, and the connection budget is sized against the concurrency.
    expect(metadata).toEqual({
      queue: 'connect.routing_capacity.reconcile',
      id: 'connect-routing:reconcile-capacity',
      concurrency: 3,
    })
    expect(metadata.queue).toBe(CONNECT_ROUTING_QUEUES.capacityReconcile)
  })

  it('validates the scope before resolving or reading anything', async () => {
    const reconcile = jest.fn()
    for (const payload of [
      undefined,
      {},
      { tenantId: SCOPE.tenantId },
      { tenantId: 'not-a-uuid', organizationId: SCOPE.organizationId },
      { ...SCOPE, extra: 'nope' },
    ]) {
      await expect(
        handle({ payload } as QueuedJob<unknown>, createContext(reconcile)),
      ).rejects.toThrow()
    }
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('passes the validated scope through and stays deferral-free', async () => {
    const reconcile = jest.fn(async () => ({
      outcome: 'reconciled' as const,
      examined: 1,
      created: 1,
      updated: 0,
      zeroed: 0,
      generation: 1,
    }))

    await handle({ payload: SCOPE } as QueuedJob<unknown>, createContext(reconcile))

    // The worker IS the deferral target, so it never defers again.
    expect(reconcile).toHaveBeenCalledWith(SCOPE)
    expect(reconcile.mock.calls[0][0]).not.toHaveProperty('defer')
  })

  it('does not throw when Connect is absent, because a retry cannot fix that', async () => {
    const reconcile = jest.fn(async () => ({
      outcome: 'dependency_unavailable' as const,
      errorCode: 'connect_reader_unavailable' as const,
    }))

    await expect(
      handle({ payload: SCOPE } as QueuedJob<unknown>, createContext(reconcile)),
    ).resolves.toBeUndefined()
  })

  it('lets a projection failure surface so the queue retries it', async () => {
    const reconcile = jest.fn(async () => {
      throw new Error('[internal] scope_lock_timeout')
    })

    await expect(
      handle({ payload: SCOPE } as QueuedJob<unknown>, createContext(reconcile)),
    ).rejects.toThrow('scope_lock_timeout')
  })

  it('accepts a redelivered job with the identical payload', () => {
    expect(reconcileCapacityPayloadSchema.parse(SCOPE)).toEqual(SCOPE)
    expect(reconcileCapacityPayloadSchema.parse({ ...SCOPE })).toEqual(SCOPE)
  })
})
