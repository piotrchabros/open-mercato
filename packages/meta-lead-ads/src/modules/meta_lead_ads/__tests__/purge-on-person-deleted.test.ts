import handle, { metadata } from '../subscribers/purge-on-person-deleted'
import { MetaConsent, MetaLeadEvent, MetaPersonKey } from '../data/entities'

function buildEm() {
  const forked = { find: jest.fn().mockResolvedValue([]) }
  return {
    fork: jest.fn(() => forked),
    find: forked.find,
    nativeUpdate: jest.fn().mockResolvedValue(0),
    nativeDelete: jest.fn().mockResolvedValue(1),
  }
}

describe('purge-on-person-deleted subscriber', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const organizationId = '22222222-2222-4222-8222-222222222222'
  const personId = '33333333-3333-4333-8333-333333333333'

  it('declares a persistent subscriber for customers.person.deleted', () => {
    expect(metadata).toEqual({
      event: 'customers.person.deleted',
      persistent: true,
      id: 'meta_lead_ads:purge-on-person-deleted',
    })
  })

  it('purges events with hashes cleared and hard-deletes keys and consents within scope', async () => {
    const em = buildEm()
    await handle({ entityId: personId, tenantId, organizationId }, { resolve: () => em as never })
    const [entity, filter] = em.find.mock.calls[0]
    expect(entity).toBe(MetaLeadEvent)
    expect(JSON.stringify(filter)).toContain(personId)
    expect(JSON.stringify(filter)).toContain(tenantId)
    expect(JSON.stringify(filter)).toContain(organizationId)
    const scope = { tenantId, organizationId, personId }
    expect(em.nativeDelete).toHaveBeenCalledWith(MetaPersonKey, scope)
    expect(em.nativeDelete).toHaveBeenCalledWith(MetaConsent, scope)
    expect(em.nativeDelete).not.toHaveBeenCalledWith(MetaLeadEvent, expect.anything())
  })

  it('falls back to id when entityId is absent', async () => {
    const em = buildEm()
    await handle({ id: personId, tenantId, organizationId }, { resolve: () => em as never })
    expect(em.nativeDelete).toHaveBeenCalledWith(MetaPersonKey, { tenantId, organizationId, personId })
  })

  it('does nothing without a person or scope', async () => {
    const em = buildEm()
    await handle({ tenantId, organizationId }, { resolve: () => em as never })
    await handle({ id: personId, tenantId }, { resolve: () => em as never })
    expect(em.nativeDelete).not.toHaveBeenCalled()
    expect(em.find).not.toHaveBeenCalled()
  })
})
