import * as fs from 'node:fs'
import * as path from 'node:path'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'

const source = fs.readFileSync(path.resolve(__dirname, '..', 'administration.ts'), 'utf8')

describe('Connect SLA administration commands', () => {
  it.each([
      'connect_sla.calendar.create',
      'connect_sla.calendar.update',
      'connect_sla.calendar.delete',
      'connect_sla.calendar.publish',
      'connect_sla.policy.create',
      'connect_sla.policy.update',
      'connect_sla.policy.delete',
      'connect_sla.policy.publish',
    ])('registers canonical command %s', (commandId) => {
    expect(source).toContain(`id: '${commandId}'`)
  })

  it('uses the canonical undo envelope and immutable publication copies', () => {
    expect(source).toContain('extractUndoPayload<')
    expect(source).toContain('copyCalendarVersion')
    expect(source).toContain('transactionalEm.create(PolicyVersion')
    expect(extractUndoPayload({ commandPayload: { undo: { publishedVersion: 5 } } })).toEqual({ publishedVersion: 5 })
  })

  it('protects optimistic mutations and referenced versions', () => {
    expect(source).toContain('enforceCommandOptimisticLock')
    expect(source).toContain("code: 'calendar_version_referenced'")
    expect(source).toContain("code: 'policy_version_referenced'")
  })
})
