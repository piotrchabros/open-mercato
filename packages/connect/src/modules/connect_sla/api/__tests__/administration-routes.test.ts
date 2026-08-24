import * as fs from 'node:fs'
import * as path from 'node:path'
const API_ROOT = path.resolve(__dirname, '..')

describe('Connect SLA administration API contracts', () => {
  it('uses per-method view/manage metadata', () => {
    const source = fs.readFileSync(path.join(API_ROOT, 'administration.ts'), 'utf8')
    expect(source).toContain("GET: { requireAuth: true, requireFeatures: ['connect_sla.calendar.view'] }")
    expect(source).toContain("POST: { requireAuth: true, requireFeatures: ['connect_sla.calendar.manage'] }")
    expect(source).toContain("GET: { requireAuth: true, requireFeatures: ['connect_sla.policy.view'] }")
    expect(source).toContain("DELETE: { requireAuth: true, requireFeatures: ['connect_sla.policy.manage'] }")
  })

  it('keeps identity CRUD on makeCrudRoute and decrypts holiday labels under scope', () => {
    const source = fs.readFileSync(path.join(API_ROOT, 'administration.ts'), 'utf8')
    expect(source).toContain('makeCrudRoute')
    expect(source).toContain('findWithDecryption(em, BusinessHoliday')
    expect(source).toContain("indexer: { entityType: 'connect_sla:business_calendar' }")
    expect(source).toContain("indexer: { entityType: 'connect_sla:policy' }")
  })

  it('wires publish actions through all mutation guards and the command bus', () => {
    const source = fs.readFileSync(path.join(API_ROOT, 'publish-route.ts'), 'utf8')
    expect(source).toContain('getAllMutationGuardInstances()')
    expect(source).toContain('bridgeLegacyGuard(container)')
    expect(source).toContain('runMutationGuards')
    expect(source).toContain("container.resolve('commandBus')")
  })

  it.each(['calendars/[id]/publish/route.ts', 'policies/[id]/publish/route.ts'])(
    '%s exports POST metadata and OpenAPI',
    (relativePath) => {
      const source = fs.readFileSync(path.join(API_ROOT, relativePath), 'utf8')
      expect(source).toContain('export const metadata')
      expect(source).toContain('export async function POST')
      expect(source).toContain('export const openApi')
    },
  )

  it('passes backend route ids into edit forms and deletes through item routes', () => {
    const moduleRoot = path.resolve(API_ROOT, '..')
    const calendarPage = fs.readFileSync(path.join(moduleRoot, 'backend/connect/sla/calendars/[id]/page.tsx'), 'utf8')
    const policyPage = fs.readFileSync(path.join(moduleRoot, 'backend/connect/sla/policies/[id]/page.tsx'), 'utf8')
    const form = fs.readFileSync(path.join(moduleRoot, 'components/SlaAdminForm.tsx'), 'utf8')
    const table = fs.readFileSync(path.join(moduleRoot, 'components/SlaAdminTable.tsx'), 'utf8')

    expect(calendarPage).toContain('recordId={typeof params?.id')
    expect(policyPage).toContain('recordId={typeof params?.id')
    expect(form).toContain('`${endpoint}/${encodeURIComponent(recordId)}`')
    expect(form).not.toContain('useParams')
    expect(table).toContain('`${endpoint}/${encodeURIComponent(row.id)}`')
    expect(table).not.toContain('`${endpoint}?id=${encodeURIComponent(row.id)}`')
  })
})
