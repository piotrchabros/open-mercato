import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findPeopleByAddresses } from '@open-mercato/core/modules/customers/lib/findPeopleByAddresses'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { emailHashLookupValues } from '@open-mercato/core/modules/auth/lib/emailHash'
import {
  excludeStaffAttendees,
  resolveCalcomCustomers,
  resolveOrganizerUser,
  splitAttendeeName,
} from '../lib/people'

jest.mock('@open-mercato/core/modules/customers/lib/findPeopleByAddresses', () => ({
  ...jest.requireActual('@open-mercato/core/modules/customers/lib/findPeopleByAddresses'),
  findPeopleByAddresses: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

const findPeople = findPeopleByAddresses as jest.Mock
const findOne = findOneWithDecryption as jest.Mock
const findMany = findWithDecryption as jest.Mock
const scope = { tenantId: 't-1', organizationId: 'o-1' }
const em = {} as EntityManager
const commandCtx = {} as CommandRuntimeContext

function buildDeps(createdId = 'new-1') {
  const execute = jest.fn().mockResolvedValue({ result: { entityId: createdId, personId: 'p' }, logEntry: null })
  return { deps: { em, commandBus: { execute } as unknown as CommandBus, commandCtx }, execute }
}

describe('resolveCalcomCustomers', () => {
  beforeEach(() => jest.clearAllMocks())

  it('uses the first matching attendee as primary', async () => {
    findPeople.mockResolvedValue([{ id: 'c-1', email: 'a@x.com' }])
    const { deps, execute } = buildDeps()
    const out = await resolveCalcomCustomers(deps, scope, [{ name: 'Ann Lee', email: ' A@X.com ' }], 'create_person')
    expect(findPeople).toHaveBeenCalledWith(em, ['a@x.com'], 't-1', 'o-1')
    expect(out).toEqual({ primaryEntityId: 'c-1', linkedEntities: [], createdPersonId: null })
    expect(execute).not.toHaveBeenCalled()
  })

  it('links additional matches', async () => {
    findPeople.mockResolvedValue([{ id: 'c-2', email: 'b@x.com' }, { id: 'c-1', email: 'a@x.com' }])
    const { deps } = buildDeps()
    const out = await resolveCalcomCustomers(
      deps,
      scope,
      [{ name: 'Ann Lee', email: 'a@x.com' }, { name: 'Bob Ray', email: 'b@x.com' }],
      'skip',
    )
    expect(out.primaryEntityId).toBe('c-1')
    expect(out.linkedEntities).toEqual([{ id: 'c-2', type: 'person', label: 'Bob Ray' }])
  })

  it('creates a person from the first attendee when none match', async () => {
    findPeople.mockResolvedValue([])
    const { deps, execute } = buildDeps('new-9')
    const out = await resolveCalcomCustomers(
      deps,
      scope,
      [{ name: 'No Mail' }, { name: 'Ann Marie Lee', email: 'A@x.com' }],
      'create_person',
    )
    expect(out).toEqual({ primaryEntityId: 'new-9', linkedEntities: [], createdPersonId: 'new-9' })
    expect(execute).toHaveBeenCalledWith('customers.people.create', {
      input: {
        organizationId: 'o-1',
        tenantId: 't-1',
        firstName: 'Ann Marie',
        lastName: 'Lee',
        displayName: 'Ann Marie Lee',
        primaryEmail: 'a@x.com',
        source: 'calcom',
      },
      ctx: commandCtx,
    })
  })

  it('does not create when policy is skip', async () => {
    findPeople.mockResolvedValue([])
    const { deps, execute } = buildDeps()
    const out = await resolveCalcomCustomers(deps, scope, [{ email: 'a@x.com' }], 'skip')
    expect(out).toEqual({ primaryEntityId: null, linkedEntities: [], createdPersonId: null })
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns empty when no attendee has a valid email', async () => {
    const { deps, execute } = buildDeps()
    const out = await resolveCalcomCustomers(deps, scope, [{ name: 'A' }, { email: 'nope' }], 'create_person')
    expect(out).toEqual({ primaryEntityId: null, linkedEntities: [], createdPersonId: null })
    expect(findPeople).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('splitAttendeeName', () => {
  it('prefers explicit first/last name', () => {
    expect(splitAttendeeName({ firstName: 'Ann', lastName: 'Lee', name: 'X Y' })).toEqual({ firstName: 'Ann', lastName: 'Lee' })
  })
  it('splits name on the last space', () => {
    expect(splitAttendeeName({ name: 'Ann Marie Lee' })).toEqual({ firstName: 'Ann Marie', lastName: 'Lee' })
  })
  it('never yields empty parts for a single name', () => {
    expect(splitAttendeeName({ name: 'Cher' })).toEqual({ firstName: 'Cher', lastName: 'Cher' })
  })
  it('falls back to the email local part', () => {
    expect(splitAttendeeName({ email: 'jo.doe@x.com' })).toEqual({ firstName: 'jo.doe', lastName: 'jo.doe' })
  })
  it('fills a missing last name', () => {
    expect(splitAttendeeName({ firstName: 'Ann' })).toEqual({ firstName: 'Ann', lastName: 'Ann' })
  })
})

describe('resolveOrganizerUser', () => {
  beforeEach(() => jest.clearAllMocks())

  it('looks up by email hash within the tenant', async () => {
    findOne.mockResolvedValue({ id: 'u-1', name: 'Org Anizer' })
    const out = await resolveOrganizerUser(em, scope, ' Boss@X.com ')
    expect(out).toEqual({ id: 'u-1', name: 'Org Anizer' })
    const filter = findOne.mock.calls[0][2]
    expect(filter.tenantId).toBe('t-1')
    expect(filter.deletedAt).toBeNull()
    expect(filter.emailHash.$in.length).toBeGreaterThan(0)
  })

  it('returns null when not found or email empty', async () => {
    findOne.mockResolvedValue(null)
    expect(await resolveOrganizerUser(em, scope, 'x@y.com')).toBeNull()
    expect(await resolveOrganizerUser(em, scope, '  ')).toBeNull()
  })
})

describe('excludeStaffAttendees', () => {
  beforeEach(() => jest.clearAllMocks())

  it('drops attendees matching CRM users case-insensitively with a single query', async () => {
    const [staffHash] = emailHashLookupValues('boss@x.com')
    findMany.mockResolvedValue([{ id: 'u-1', emailHash: staffHash }])
    const attendees = [
      { name: 'Boss', email: ' Boss@X.com ' },
      { name: 'Client', email: 'client@y.com' },
      { name: 'No Mail' },
    ]
    const out = await excludeStaffAttendees(em, scope, attendees)
    expect(out).toEqual([{ name: 'Client', email: 'client@y.com' }, { name: 'No Mail' }])
    expect(findMany).toHaveBeenCalledTimes(1)
    const filter = findMany.mock.calls[0][2]
    expect(filter.tenantId).toBe('t-1')
    expect(filter.deletedAt).toBeNull()
    expect(filter.emailHash.$in).toEqual(
      expect.arrayContaining([...emailHashLookupValues('boss@x.com'), ...emailHashLookupValues('client@y.com')]),
    )
  })

  it('keeps everyone when no user matches', async () => {
    findMany.mockResolvedValue([])
    const attendees = [{ email: 'client@y.com' }]
    expect(await excludeStaffAttendees(em, scope, attendees)).toEqual(attendees)
  })

  it('skips the query when no attendee has an email', async () => {
    const attendees = [{ name: 'A' }]
    expect(await excludeStaffAttendees(em, scope, attendees)).toEqual(attendees)
    expect(await excludeStaffAttendees(em, scope, [])).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })
})
