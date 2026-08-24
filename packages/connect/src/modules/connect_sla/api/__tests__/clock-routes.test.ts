import fs from 'node:fs'
import path from 'node:path'

const CLOCKS = fs.readFileSync(path.resolve(__dirname, '../clocks/route.ts'), 'utf8')
const REBUILD = fs.readFileSync(path.resolve(__dirname, '../clocks/rebuild/route.ts'), 'utf8')
const STATUS = fs.readFileSync(path.resolve(__dirname, '../clocks/rebuild/[id]/route.ts'), 'utf8')
const CONTEXT = fs.readFileSync(path.resolve(__dirname, '../clock-context.ts'), 'utf8')

describe('connect SLA clock HTTP contracts', () => {
  it('pins the additive paths and exact ACL metadata', () => {
    expect(CLOCKS).toContain("path: '/connect-sla/clocks'")
    expect(CLOCKS).toContain("GET: { requireAuth: true, requireFeatures: ['connect_sla.clock.view'] }")
    expect(REBUILD).toContain("path: '/connect-sla/clocks/rebuild'")
    expect(REBUILD).toContain("POST: { requireAuth: true, requireFeatures: ['connect_sla.clock.rebuild'] }")
    expect(STATUS).toContain("path: '/connect-sla/clocks/rebuild/[id]'")
    expect(STATUS).toContain("GET: { requireAuth: true, requireFeatures: ['connect_sla.clock.rebuild'] }")
  })

  it('fails closed when Connect case visibility is unavailable', () => {
    expect(CONTEXT).toContain("hasRegistration?.('connectCaseSlaReader')")
    expect(CONTEXT).toContain("apiError(503, 'dependency_unavailable'")
    expect(CLOCKS).toContain('reader.canReadCase')
    expect(CLOCKS).toContain("apiError(404, 'clock_not_found'")
  })

  it('derives tenant and organization scope only from authenticated context', () => {
    expect(CONTEXT).toContain('auth.tenantId')
    expect(CONTEXT).toContain('auth.orgId')
    expect(CLOCKS).toContain('tenantId, organizationId')
    expect(STATUS).toContain('{ id: id.data, tenantId, organizationId }')
  })

  it('caps cursor pages and documents all required errors', () => {
    expect(CLOCKS).toContain('query.data.pageSize + 1')
    for (const status of [400, 401, 403, 404, 503]) expect(CLOCKS).toContain(`status: ${status}`)
    for (const status of [400, 401, 403, 409, 422, 503]) expect(REBUILD).toContain(`status: ${status}`)
  })

  it('runs rebuilds through registry and legacy mutation guards before enqueue', () => {
    expect(REBUILD).toContain('getAllMutationGuardInstances()')
    expect(REBUILD).toContain('bridgeLegacyGuard(container)')
    expect(REBUILD).toContain('runMutationGuards(')
    expect(REBUILD.indexOf('runMutationGuards(')).toBeLessThan(REBUILD.indexOf('queue.enqueue('))
    expect(REBUILD).toContain('guardResult.afterSuccessCallbacks')
  })

  it('enforces idempotent keys and rejects overlapping scoped runs', () => {
    expect(REBUILD).toContain('commandKey: input.commandKey')
    expect(REBUILD).toContain("status: { $in: ['pending', 'running'] }")
    expect(REBUILD).toContain("apiError(409, 'rebuild_overlap'")
    expect(REBUILD).toContain("apiError(409, 'rebuild_conflict'")
  })
})
