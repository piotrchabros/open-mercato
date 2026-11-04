import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { findPeopleByAddresses, normalizeAddresses } from '@open-mercato/core/modules/customers/lib/findPeopleByAddresses'
import { emailHashLookupValues } from '@open-mercato/core/modules/auth/lib/emailHash'
import { User } from '@open-mercato/core/modules/auth/data/entities'

export type CalcomAttendeeInput = {
  name?: string | null
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}

export type CalcomPersonPolicy = 'create_person' | 'skip'

export type CalcomPeopleScope = { tenantId: string; organizationId: string }

export type CalcomPeopleDeps = {
  em: EntityManager
  commandBus: CommandBus
  commandCtx: CommandRuntimeContext
}

export type CalcomLinkedEntity = { id: string; type: 'person'; label: string }

export type CalcomCustomerResolution = {
  primaryEntityId: string | null
  linkedEntities: CalcomLinkedEntity[]
  createdPersonId: string | null
}

const PERSON_SOURCE = 'calcom'

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedEmail(attendee: CalcomAttendeeInput): string | null {
  const [email] = normalizeAddresses([attendee.email])
  return email ?? null
}

export function splitAttendeeName(attendee: CalcomAttendeeInput): { firstName: string; lastName: string } {
  const explicitFirst = clean(attendee.firstName)
  const explicitLast = clean(attendee.lastName)
  const fullName = clean(attendee.name)
  const localPart = clean(attendee.email).split('@')[0] || 'Guest'
  if (explicitFirst || explicitLast) {
    const fallbackParts = fullName.split(/\s+/).filter(Boolean)
    const fallbackFirst = fallbackParts.length > 1 ? fallbackParts.slice(0, -1).join(' ') : fallbackParts[0] ?? localPart
    const fallbackLast = fallbackParts.length > 1 ? fallbackParts[fallbackParts.length - 1] : ''
    const firstName = explicitFirst || explicitLast || fallbackFirst
    const lastName = explicitLast || (explicitFirst ? fallbackLast || explicitFirst : fallbackLast) || firstName
    return { firstName, lastName }
  }
  if (fullName) {
    const index = fullName.lastIndexOf(' ')
    if (index > 0) {
      return { firstName: fullName.slice(0, index).trim(), lastName: fullName.slice(index + 1).trim() }
    }
    return { firstName: fullName, lastName: fullName }
  }
  return { firstName: localPart, lastName: localPart }
}

function displayLabel(attendee: CalcomAttendeeInput, email: string): string {
  const fullName = clean(attendee.name)
  if (fullName) return fullName
  const { firstName, lastName } = splitAttendeeName(attendee)
  const joined = firstName === lastName ? firstName : `${firstName} ${lastName}`.trim()
  return joined || email
}

export async function resolveCalcomCustomers(
  deps: CalcomPeopleDeps,
  scope: CalcomPeopleScope,
  attendees: CalcomAttendeeInput[],
  policy: CalcomPersonPolicy,
): Promise<CalcomCustomerResolution> {
  const withEmail = attendees
    .map((attendee) => ({ attendee, email: normalizedEmail(attendee) }))
    .filter((entry): entry is { attendee: CalcomAttendeeInput; email: string } => entry.email !== null)
  if (withEmail.length === 0) return { primaryEntityId: null, linkedEntities: [], createdPersonId: null }

  const matches = await findPeopleByAddresses(
    deps.em,
    withEmail.map((entry) => entry.email),
    scope.tenantId,
    scope.organizationId,
  )
  const personByEmail = new Map(matches.map((match) => [match.email, match.id]))

  const resolved: Array<{ id: string; label: string }> = []
  const seenIds = new Set<string>()
  for (const { attendee, email } of withEmail) {
    const id = personByEmail.get(email)
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    resolved.push({ id, label: displayLabel(attendee, email) })
  }

  if (resolved.length > 0) {
    const [primary, ...others] = resolved
    return {
      primaryEntityId: primary.id,
      linkedEntities: others.map((other) => ({ id: other.id, type: 'person' as const, label: other.label })),
      createdPersonId: null,
    }
  }

  if (policy !== 'create_person') return { primaryEntityId: null, linkedEntities: [], createdPersonId: null }

  const first = withEmail[0]
  const { firstName, lastName } = splitAttendeeName(first.attendee)
  const { result } = await deps.commandBus.execute<Record<string, unknown>, { entityId: string; personId: string }>(
    'customers.people.create',
    {
      input: {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        firstName,
        lastName,
        displayName: displayLabel(first.attendee, first.email),
        primaryEmail: first.email,
        source: PERSON_SOURCE,
      },
      ctx: deps.commandCtx,
    },
  )
  return { primaryEntityId: result.entityId, linkedEntities: [], createdPersonId: result.entityId }
}

export async function resolveOrganizerUser(
  em: EntityManager,
  scope: CalcomPeopleScope,
  email: string,
): Promise<{ id: string; name: string | null } | null> {
  const normalized = clean(email).toLowerCase()
  if (!normalized) return null
  const user = await findOneWithDecryption(
    em,
    User,
    {
      emailHash: { $in: emailHashLookupValues(normalized) },
      tenantId: scope.tenantId,
      deletedAt: null,
    },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (!user) return null
  return { id: user.id, name: user.name ?? null }
}

export async function excludeStaffAttendees(
  em: EntityManager,
  scope: CalcomPeopleScope,
  attendees: CalcomAttendeeInput[],
): Promise<CalcomAttendeeInput[]> {
  const emailByHash = new Map<string, string>()
  for (const attendee of attendees) {
    const email = clean(attendee.email).toLowerCase()
    if (!email) continue
    for (const hash of emailHashLookupValues(email)) emailByHash.set(hash, email)
  }
  if (emailByHash.size === 0) return attendees
  const users = await findWithDecryption(
    em,
    User,
    {
      emailHash: { $in: Array.from(emailByHash.keys()) },
      tenantId: scope.tenantId,
      deletedAt: null,
    },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  const staffEmails = new Set<string>()
  for (const user of users) {
    const email = user.emailHash ? emailByHash.get(user.emailHash) : undefined
    if (email) staffEmails.add(email)
  }
  if (staffEmails.size === 0) return attendees
  return attendees.filter((attendee) => !staffEmails.has(clean(attendee.email).toLowerCase()))
}
