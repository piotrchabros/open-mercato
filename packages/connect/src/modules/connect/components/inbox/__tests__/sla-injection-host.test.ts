import * as fs from 'node:fs'
import * as path from 'node:path'
import { extensionPoints } from '../../../extension-points'

describe('Connect Inbox SLA extension host', () => {
  it('declares and mounts the frozen Connect-owned host context', () => {
    expect(extensionPoints.hosts.inboxCaseDetailSla.spotId).toBe('connect:inbox:case-detail:sla')

    const source = fs.readFileSync(path.resolve(__dirname, '..', 'ConnectInboxPage.tsx'), 'utf8')
    expect(source).toContain('spotId={extensionPoints.hosts.inboxCaseDetailSla.spotId}')
    expect(source).toContain('context={{ caseId: selected.id, retryLastMutation }}')
    expect(source).not.toContain('connect_sla')
  })
})
