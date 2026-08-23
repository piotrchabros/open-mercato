import commands, { parseReconcileCapacityArgs } from '../cli'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'

describe('connect routing capacity CLI', () => {
  it('registers exactly the retry command', () => {
    expect(commands.map((entry) => entry.command)).toEqual(['reconcile-capacity'])
  })

  it('parses an explicit tenant and organization', () => {
    expect(
      parseReconcileCapacityArgs([
        '--tenant-id',
        TENANT_ID,
        '--organization-id',
        ORGANIZATION_ID,
      ]),
    ).toEqual({ tenantId: TENANT_ID, organizationId: ORGANIZATION_ID })
  })

  it('refuses to infer a scope', () => {
    // A command that discovered its own scope could widen it after a partial
    // failure — the moment an operator is least able to notice.
    for (const args of [
      [],
      ['--tenant-id', TENANT_ID],
      ['--organization-id', ORGANIZATION_ID],
      ['--tenant-id', TENANT_ID, '--organization-id', 'not-a-uuid'],
      ['--tenant-id', '--organization-id', ORGANIZATION_ID],
      ['reconcile-capacity', '--tenant-id', TENANT_ID],
    ]) {
      expect(() => parseReconcileCapacityArgs(args)).toThrow()
    }
  })
})
