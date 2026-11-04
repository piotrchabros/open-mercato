import { NOTIFICATION_TYPES, notificationTypes } from '../notifications'

describe('meta_lead_ads notification types', () => {
  it('keeps NOTIFICATION_TYPES in sync with the notification definitions', () => {
    const declaredTypes = Object.values(NOTIFICATION_TYPES).sort()
    const definedTypes = notificationTypes.map((definition) => definition.type).sort()
    expect(declaredTypes).toEqual(definedTypes)
  })

  it('declares every notification type only once', () => {
    const definedTypes = notificationTypes.map((definition) => definition.type)
    expect(new Set(definedTypes).size).toBe(definedTypes.length)
    const declaredTypes = Object.values(NOTIFICATION_TYPES)
    expect(new Set(declaredTypes).size).toBe(declaredTypes.length)
  })
})
