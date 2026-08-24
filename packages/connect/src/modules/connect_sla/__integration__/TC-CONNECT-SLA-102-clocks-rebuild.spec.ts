import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { seedCase } from '../../connect/__integration__/helpers/reparentingFixtures'
import { openReparentingSpec } from '../../connect/__integration__/helpers/reparentingSpec'
import { fixtureName, openSlaSpec } from './helpers/slaSpec'

test.describe('TC-CONNECT-SLA-102: clock visibility and rebuild coordination', () => {
  test('returns only clocks whose Connect case is visible in scope', async ({ request }) => {
    test.setTimeout(45_000)
    const sla = await openSlaSpec(request)
    const connect = await openReparentingSpec(request)
    const foreignOrganizationId = randomUUID()
    try {
      const visibleCase = await seedCase(connect.em, connect.scope, { channelId: connect.channelId })
      connect.ledger.trackCase(visibleCase.id)
      const foreignCase = await seedCase(connect.em, { ...connect.scope, organizationId: foreignOrganizationId }, { channelId: connect.channelId })
      connect.ledger.trackCase(foreignCase.id)

      const clockId = randomUUID()
      const calendarId = randomUUID()
      const calendarVersionId = randomUUID()
      const policyId = randomUUID()
      const policyVersionId = randomUUID()
      sla.ledger.clockIds.add(clockId)
      sla.ledger.calendarIds.add(calendarId)
      sla.ledger.policyIds.add(policyId)
      await sla.em.getConnection().execute(
        `insert into connect_sla_business_calendars
          (id, tenant_id, organization_id, name, is_default, current_version, created_at, updated_at)
         values (?, ?, ?, ?, false, 1, now(), now());
         insert into connect_sla_business_calendar_versions
          (id, tenant_id, organization_id, calendar_id, version, timezone, published_at, created_at)
         values (?, ?, ?, ?, 1, 'UTC', now(), now());
         insert into connect_sla_policies
          (id, tenant_id, organization_id, name, priority, is_active, current_version, created_at, updated_at)
         values (?, ?, ?, ?, 1, true, 1, now(), now());
         insert into connect_sla_policy_versions
          (id, tenant_id, organization_id, policy_id, version, channel_id, response_target_minutes,
           resolution_target_minutes, response_warning_minutes, resolution_warning_minutes,
           calendar_version_id, effective_from, published_at, created_at)
         values (?, ?, ?, ?, 1, null, 60, 480, 15, 60, ?, now(), now(), now())`,
        [
          calendarId, sla.scope.tenantId, sla.scope.organizationId, fixtureName('clock-calendar'),
          calendarVersionId, sla.scope.tenantId, sla.scope.organizationId, calendarId,
          policyId, sla.scope.tenantId, sla.scope.organizationId, fixtureName('clock-policy'),
          policyVersionId, sla.scope.tenantId, sla.scope.organizationId, policyId, calendarVersionId,
        ],
      )
      await sla.em.getConnection().execute(
        `insert into connect_sla_case_clocks
          (id, tenant_id, organization_id, case_id, generation, source_event_id,
           policy_version_id, calendar_version_id, started_at, response_due_at,
           resolution_due_at, response_state, resolution_state, resolution_paused_seconds,
           internal_version, created_at, updated_at)
         values (?, ?, ?, ?, 0, ?, ?, ?, now(), now() + interval '1 hour',
           now() + interval '8 hours', 'open', 'open', 0, 1, now(), now())`,
        [clockId, sla.scope.tenantId, sla.scope.organizationId, visibleCase.id, fixtureName('event'), policyVersionId, calendarVersionId],
      )

      const visible = await request.get(`/api/connect-sla/clocks?caseId=${visibleCase.id}`, { headers: sla.authHeaders })
      expect(visible.status()).toBe(200)
      expect(JSON.stringify(await visible.json())).toContain(clockId)

      const hidden = await request.get(`/api/connect-sla/clocks?caseId=${foreignCase.id}`, { headers: sla.authHeaders })
      expect(hidden.status()).toBe(404)
    } finally {
      await sla.ledger.cleanup(sla.em, sla.scope)
      await connect.ledger.cleanup(connect.em)
    }
  })

  test('replays one rebuild key and rejects an overlapping run', async ({ request }) => {
    const ctx = await openSlaSpec(request)
    try {
      const commandKey = fixtureName('sla-rebuild')
      const first = await request.post('/api/connect-sla/clocks/rebuild', {
        headers: ctx.authHeaders,
        data: { commandKey, reason: 'Integration reconciliation coverage' },
      })
      expect([200, 201, 202]).toContain(first.status())
      const firstBody = await first.json()
      const runId = firstBody.id ?? firstBody.runId
      expect(runId).toBeTruthy()
      ctx.ledger.rebuildRunIds.add(runId)

      const replay = await request.post('/api/connect-sla/clocks/rebuild', {
        headers: ctx.authHeaders,
        data: { commandKey, reason: 'Integration reconciliation coverage' },
      })
      expect([200, 202]).toContain(replay.status())
      const replayBody = await replay.json()
      expect(replayBody.id ?? replayBody.runId).toBe(runId)

      const overlap = await request.post('/api/connect-sla/clocks/rebuild', {
        headers: ctx.authHeaders,
        data: { commandKey: fixtureName('sla-overlap'), reason: 'Competing reconciliation coverage' },
      })
      expect(overlap.status()).toBe(409)

      const status = await request.get(`/api/connect-sla/clocks/rebuild/${runId}`, { headers: ctx.authHeaders })
      expect(status.status()).toBe(200)
      expect(await status.json()).toMatchObject({ id: runId })
    } finally {
      await ctx.ledger.cleanup(ctx.em, ctx.scope)
    }
  })
})
