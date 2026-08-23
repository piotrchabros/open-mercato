import fs from 'node:fs'
import path from 'node:path'
import metadata from '../index'
import { ConnectAgentPresence, ConnectRoutingCapacityCheckpoint } from '../data/entities'

const MODULE_ROOT = path.resolve(__dirname, '..')

function listSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === '__integration__' ? [] : listSourceFiles(entryPath)
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : []
  })
}

const SOURCE_FILES = listSourceFiles(MODULE_ROOT)

/**
 * `connect_routing` deliberately ships before the routing behaviour that owns
 * it, and it reads Connect's workload through a DI contract. That only stays
 * true if nothing here quietly grows a compile-time edge into Connect: an entity
 * import, an ORM relation, or a `requires` that would stop the host app booting
 * without the shared inbox installed.
 */
describe('connect_routing module decoupling', () => {
  it('finds the module sources it is meant to be checking', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0)
  })

  it('imports nothing from the connect module', () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return /from\s+['"][^'"]*modules\/connect\/[^'"]*['"]/.test(source)
        || /from\s+['"]\.\.\/\.\.\/connect\//.test(source)
    })
    expect(offenders.map((file) => path.relative(MODULE_ROOT, file))).toEqual([])
  })

  it('declares no ORM relationship on either entity', () => {
    const entities = fs.readFileSync(path.join(MODULE_ROOT, 'data', 'entities.ts'), 'utf8')
    for (const decorator of ['@ManyToOne', '@OneToMany', '@OneToOne', '@ManyToMany', '@Embedded']) {
      expect(entities).not.toContain(decorator)
    }
    // The logical links stay plain scalar columns.
    expect(new ConnectAgentPresence().status).toBe('offline')
    expect(new ConnectAgentPresence().currentCaseCount).toBe(0)
    expect(new ConnectRoutingCapacityCheckpoint().state).toBe('pending')
  })

  it('declares no hard module requirement', () => {
    expect(metadata).not.toHaveProperty('requires')
    expect(metadata.id).toBe('connect_routing')
  })

  it('resolves the Connect reader by DI key rather than by import', () => {
    const reconciler = fs.readFileSync(path.join(MODULE_ROOT, 'lib', 'reconcile-capacity.ts'), 'utf8')
    expect(reconciler).toContain(`'connectCurrentCaseCountReader'`)
    // Resolution is guarded, so an absent Connect degrades instead of throwing
    // during tenant initialization.
    expect(reconciler).toContain('hasRegistration')
    expect(reconciler).toContain('catch')
  })

  it('exposes no API route, page or ACL surface while routing is gated off', () => {
    for (const surface of ['api', 'backend', 'acl.ts', 'widgets', 'i18n']) {
      expect(fs.existsSync(path.join(MODULE_ROOT, surface))).toBe(false)
    }
  })
})
