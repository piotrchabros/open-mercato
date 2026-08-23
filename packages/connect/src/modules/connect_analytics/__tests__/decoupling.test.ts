import fs from 'node:fs'
import path from 'node:path'

/**
 * Analytics composes reports out of what Connect chooses to publish. The moment
 * it reaches for an entity, a table name or a peer module's storage, the
 * privacy guarantee stops being enforceable by review — so it is enforced here.
 */

const MODULE_ROOT = path.resolve(__dirname, '..')

const FORBIDDEN_PEER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+['"][^'"]*connect\/data\/entities['"]/, reason: 'imports a Connect ORM entity' },
  { pattern: /connect_metric_daily|connect_operational_facts|connect_cases/, reason: 'names a Connect table' },
]

const OPERATIONAL_REPORT_PATHS = [
  `${path.sep}api${path.sep}reports${path.sep}operational${path.sep}`,
  `${path.sep}backend${path.sep}connect${path.sep}analytics${path.sep}page.tsx`,
  `${path.sep}components${path.sep}OperationalReport.client.tsx`,
  `${path.sep}lib${path.sep}load-operational-report.ts`,
  `${path.sep}lib${path.sep}report-composer.ts`,
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
  const operationalReportFiles = files.filter((file) =>
    OPERATIONAL_REPORT_PATHS.some((suffix) => file.includes(suffix)),
  )

  it('ships source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(FORBIDDEN_PEER_PATTERNS)('never $reason', ({ pattern }) => {
    const offenders = files.filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('keeps the operational report independent from the ORM', () => {
    const offenders = operationalReportFiles.filter((file) => /@mikro-orm\//.test(fs.readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('names no per-person identifier in the operational report', () => {
    const offenders = operationalReportFiles.filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return FORBIDDEN_IDENTIFIER_FIELDS.some((field) => new RegExp(`\\b${field}\\b`).test(source))
    })
    expect(offenders).toEqual([])
  })

  it('keeps operational and cost-input grants distinct and grants read access to managers', async () => {
    const { features } = await import('../acl')
    const { setup } = await import('../setup')
    expect(features.map((feature) => feature.id)).toEqual([
      'connect_analytics.view',
      'connect_analytics.cost_inputs.view',
      'connect_analytics.cost_inputs.manage',
    ])
    expect(setup.defaultRoleFeatures?.manager).toEqual([
      'connect_analytics.view',
      'connect_analytics.cost_inputs.view',
    ])
    expect(setup.defaultRoleFeatures?.employee).toBeUndefined()
  })
})
