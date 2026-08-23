import { parsePrincipalReconcileArgs } from '../cli'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'

describe('connect principals CLI', () => {
  it('defaults to dry-run and accepts only exact scoped manifest arguments', () => {
    expect(parsePrincipalReconcileArgs([
      'reconcile',
      '--tenant', TENANT_ID,
      '--organization', ORGANIZATION_ID,
      '--manifest', '/tmp/principals.json',
    ])).toEqual({
      tenant: TENANT_ID,
      organization: ORGANIZATION_ID,
      manifest: '/tmp/principals.json',
    })
  })

  it('recognizes explicit apply without accepting heuristic selectors', () => {
    expect(parsePrincipalReconcileArgs([
      'reconcile',
      '--tenant', TENANT_ID,
      '--organization', ORGANIZATION_ID,
      '--manifest', '/tmp/principals.json',
      '--apply',
    ])).toMatchObject({ apply: true })
    expect(() => parsePrincipalReconcileArgs([
      'reconcile',
      '--tenant', TENANT_ID,
      '--organization', ORGANIZATION_ID,
      '--manifest', '/tmp/principals.json',
      '--email', 'bot@example.test',
    ])).toThrow()
  })
})
