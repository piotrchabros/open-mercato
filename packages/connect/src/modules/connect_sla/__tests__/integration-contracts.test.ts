import * as fs from 'node:fs'
import * as path from 'node:path'

const INTEGRATION_ROOT = path.resolve(__dirname, '../__integration__')

function collectTypescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? collectTypescriptFiles(absolute) : entry.name.endsWith('.ts') ? [absolute] : []
  })
}

describe('Connect SLA integration suite contracts', () => {
  const files = collectTypescriptFiles(INTEGRATION_ROOT)
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')

  it('imports no ORM entity modules', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
    const entityImport = /from\s+['"][^'"]*data\/entities(?:\/[^'"]*)?['"]/
    expect(source).not.toMatch(entityImport)
  })

  it('uses the canonical administration, clock, rebuild, and OpenAPI paths', () => {
    for (const route of [
      '/api/connect-sla/calendars',
      '/api/connect-sla/policies',
      '/api/connect-sla/clocks?caseId=',
      '/api/connect-sla/clocks/rebuild',
      '/api/connect-sla/clocks/rebuild/${runId}',
      '/api/docs/openapi',
    ]) expect(source).toContain(route)
    expect(source).not.toContain('/api/connect-sla/rebuild-runs/')
  })
})
