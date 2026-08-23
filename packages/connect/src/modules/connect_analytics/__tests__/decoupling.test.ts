import fs from 'node:fs'
import path from 'node:path'

/**
 * Analytics composes reports out of what Connect chooses to publish. The moment
 * it reaches for an entity, a table name or a peer module's storage, the
 * privacy guarantee stops being enforceable by review — so it is enforced here.
 */

const MODULE_ROOT = path.resolve(__dirname, '..')

const FORBIDDEN_SOURCE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+['"][^'"]*connect\/data\/entities['"]/, reason: 'imports a Connect ORM entity' },
  { pattern: /@mikro-orm\//, reason: 'reaches for the ORM directly' },
  { pattern: /connect_metric_daily|connect_operational_facts|connect_cases/, reason: 'names a Connect table' },
]

/**
 * Aggregate-only means no per-person dimension can appear in a payload. Message
 * content fields (`handle`, `subject`, `body`) are covered by the strict report
 * schema instead — as bare words they collide with ordinary prose.
 */
const FORBIDDEN_IDENTIFIER_FIELDS = [
  'senderHash',
  'sender_hash',
  'customerId',
  'customer_id',
  'caseId',
  'case_id',
  'receiptId',
  'receipt_id',
]

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__integration__') return []
      return collectSourceFiles(full)
    }
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('connect_analytics module boundaries', () => {
  const files = collectSourceFiles(MODULE_ROOT)

  it('ships source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(FORBIDDEN_SOURCE_PATTERNS)('never $reason', ({ pattern }) => {
    const offenders = files.filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('names no per-person identifier anywhere in the module', () => {
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return FORBIDDEN_IDENTIFIER_FIELDS.some((field) => new RegExp(`\\b${field}\\b`).test(source))
    })
    expect(offenders).toEqual([])
  })

  it('declares exactly one ACL feature and grants it to managers, never to employees', async () => {
    const { features } = await import('../acl')
    const { setup } = await import('../setup')
    expect(features.map((feature) => feature.id)).toEqual(['connect_analytics.view'])
    expect(setup.defaultRoleFeatures?.manager).toEqual(['connect_analytics.view'])
    expect(setup.defaultRoleFeatures?.employee).toBeUndefined()
  })
})
