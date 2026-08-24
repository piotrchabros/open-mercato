import { expect, test } from '@playwright/test'
import { fixtureName, openSlaSpec, optimisticHeader } from './helpers/slaSpec'

test.describe('TC-CONNECT-SLA-101: calendar and policy administration', () => {
  test('creates, publishes, locks, and protects referenced versions', async ({ request }) => {
    const ctx = await openSlaSpec(request)
    try {
      const createCalendar = await request.post('/api/connect-sla/calendars', {
        headers: ctx.authHeaders,
        data: { name: fixtureName('sla-calendar'), isDefault: false },
      })
      expect(createCalendar.status()).toBe(201)
      const calendar = await createCalendar.json()
      ctx.ledger.calendarIds.add(calendar.id)

      const calendarList = await request.get('/api/connect-sla/calendars?page=1&pageSize=50', {
        headers: ctx.authHeaders,
      })
      expect(calendarList.status()).toBe(200)
      expect(JSON.stringify(await calendarList.json())).toContain(calendar.id)

      const publishCalendar = await request.post(`/api/connect-sla/calendars/${calendar.id}/publish`, {
        headers: { ...ctx.authHeaders, ...optimisticHeader(calendar.updatedAt) },
        data: {
          timezone: 'Europe/Berlin',
          windows: [{ weekday: 1, localStart: '09:00:00', localEnd: '17:00:00' }],
          holidays: [{ localDate: '2026-12-25', label: 'Encrypted fixture holiday' }],
        },
      })
      expect(publishCalendar.status()).toBe(200)
      const publishedCalendar = await publishCalendar.json()

      const detail = await request.get(`/api/connect-sla/calendars/${calendar.id}`, { headers: ctx.authHeaders })
      expect(detail.status()).toBe(200)
      const calendarDetail = await detail.json()
      expect(calendarDetail.currentDefinition).toMatchObject({
        version: 1,
        timezone: 'Europe/Berlin',
        holidays: [{ localDate: '2026-12-25', label: 'Encrypted fixture holiday' }],
      })

      const staleUpdate = await request.put(`/api/connect-sla/calendars/${calendar.id}`, {
        headers: { ...ctx.authHeaders, ...optimisticHeader(calendar.updatedAt) },
        data: { name: fixtureName('stale-calendar'), isDefault: false },
      })
      expect(staleUpdate.status()).toBe(409)
      expect(await staleUpdate.json()).toMatchObject({ code: 'optimistic_lock_conflict' })

      const createPolicy = await request.post('/api/connect-sla/policies', {
        headers: ctx.authHeaders,
        data: { name: fixtureName('sla-policy'), priority: 10, isActive: true },
      })
      expect(createPolicy.status()).toBe(201)
      const policy = await createPolicy.json()
      ctx.ledger.policyIds.add(policy.id)

      const publishPolicy = await request.post(`/api/connect-sla/policies/${policy.id}/publish`, {
        headers: { ...ctx.authHeaders, ...optimisticHeader(policy.updatedAt) },
        data: {
          channelId: null,
          responseTargetMinutes: 60,
          resolutionTargetMinutes: 480,
          responseWarningMinutes: 15,
          resolutionWarningMinutes: 60,
          calendarVersionId: calendarDetail.currentDefinition.id,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
      })
      expect(publishPolicy.status()).toBe(200)

      const referencedDelete = await request.delete(`/api/connect-sla/calendars/${calendar.id}`, {
        headers: { ...ctx.authHeaders, ...optimisticHeader(publishedCalendar.updatedAt) },
      })
      expect(referencedDelete.status()).toBe(409)
      expect(await referencedDelete.json()).toMatchObject({ code: 'calendar_version_referenced' })
    } finally {
      await ctx.ledger.cleanup(ctx.em, ctx.scope)
    }
  })
})
