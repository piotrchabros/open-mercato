/** @jest-environment node */

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const userId = '33333333-3333-4333-8333-333333333333'
const transcriptRowId = '44444444-4444-4444-8444-444444444444'
const personId = '55555555-5555-4555-8555-555555555555'
const otherPersonId = '66666666-6666-4666-8666-666666666666'
const interactionId = '77777777-7777-4777-8777-777777777777'
const attachmentId = '88888888-8888-4888-8888-888888888888'

const commandBusExecuteMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()
const runRouteMutationGuardsMock = jest.fn()
const runAfterSuccessMock = jest.fn()

const container = {
  resolve: jest.fn((token: string) => {
    if (token === 'commandBus') return { execute: commandBusExecuteMock }
    if (token === 'rbacService') return { userHasAllFeatures: userHasAllFeaturesMock }
    return {}
  }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => container),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => ({ sub: userId, tenantId, orgId: organizationId })),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(async () => ({
    selectedId: organizationId,
    filterIds: [organizationId],
    allowedIds: [organizationId],
    tenantId,
  })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (key: string, fallback?: string) => fallback ?? key,
  })),
}))

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: (...args: unknown[]) => runRouteMutationGuardsMock(...args),
}))

jest.mock('../../../../../commands/unassigned-transcripts', () => ({
  UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID: 'webhook_calcom.unassigned_transcripts.assign',
  UNASSIGNED_TRANSCRIPT_RESOURCE_KIND: 'webhook_calcom.unassigned_transcript',
}))

import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { POST, metadata } from '../route'

function assignRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/webhook_calcom/unassigned-transcripts/${transcriptRowId}/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const routeContext = { params: { id: transcriptRowId } }

describe('webhook_calcom unassigned transcript assign route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    userHasAllFeaturesMock.mockResolvedValue(true)
    runAfterSuccessMock.mockResolvedValue(undefined)
    runRouteMutationGuardsMock.mockResolvedValue({ ok: true, runAfterSuccess: runAfterSuccessMock })
    commandBusExecuteMock.mockResolvedValue({
      result: { id: transcriptRowId, interactionId, attachmentId, resolvedEntityId: personId, transcriptId: 'tr-1' },
      logEntry: null,
    })
  })

  it('declares the manage and interaction features', () => {
    expect(metadata.POST.requireFeatures).toEqual(['webhook_calcom.transcripts.manage', 'customers.interactions.manage'])
  })

  it('rejects an invalid body with 400 without running the command', async () => {
    const response = await POST(assignRequest({ personId: 'not-a-uuid' }), routeContext)

    expect(response.status).toBe(400)
    expect(commandBusExecuteMock).not.toHaveBeenCalled()
  })

  it('returns 403 when the caller cannot view people', async () => {
    userHasAllFeaturesMock.mockResolvedValueOnce(false)

    const response = await POST(assignRequest({ personId }), routeContext)

    expect(response.status).toBe(403)
    expect(userHasAllFeaturesMock).toHaveBeenCalledWith(userId, ['customers.people.view'], { tenantId, organizationId })
    expect(commandBusExecuteMock).not.toHaveBeenCalled()
  })

  it('runs the assign command with the request context and returns the result', async () => {
    const request = assignRequest({ personId }, { [OPTIMISTIC_LOCK_HEADER_NAME]: '2026-11-04T10:00:00.000Z' })

    const response = await POST(request, routeContext)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      interactionId,
      attachmentId,
      resolvedEntityId: personId,
      assignedToDifferentPerson: false,
    })
    expect(commandBusExecuteMock).toHaveBeenCalledWith(
      'webhook_calcom.unassigned_transcripts.assign',
      expect.objectContaining({
        input: { id: transcriptRowId, personId },
        ctx: expect.objectContaining({ request, selectedOrganizationId: organizationId }),
      }),
    )
    expect(runRouteMutationGuardsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ resourceKind: 'webhook_calcom.unassigned_transcript', resourceId: transcriptRowId }),
      }),
    )
    expect(runAfterSuccessMock).toHaveBeenCalled()
  })

  it('flags assignments that landed on a different person', async () => {
    commandBusExecuteMock.mockResolvedValueOnce({
      result: { id: transcriptRowId, interactionId, attachmentId, resolvedEntityId: otherPersonId, transcriptId: 'tr-1' },
      logEntry: null,
    })

    const response = await POST(assignRequest({ personId }), routeContext)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resolvedEntityId: otherPersonId, assignedToDifferentPerson: true })
  })

  it('passes optimistic-lock conflicts through as 409', async () => {
    const conflictBody = { error: 'Record was modified', code: 'optimistic_lock_conflict' }
    commandBusExecuteMock.mockRejectedValueOnce(new CrudHttpError(409, conflictBody))

    const response = await POST(assignRequest({ personId }), routeContext)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual(conflictBody)
    expect(runAfterSuccessMock).not.toHaveBeenCalled()
  })

  it('short-circuits when a mutation guard blocks the assignment', async () => {
    runRouteMutationGuardsMock.mockResolvedValueOnce({
      ok: false,
      errorStatus: 423,
      errorBody: { error: 'locked' },
      response: Response.json({ error: 'locked' }, { status: 423 }),
    })

    const response = await POST(assignRequest({ personId }), routeContext)

    expect(response.status).toBe(423)
    expect(commandBusExecuteMock).not.toHaveBeenCalled()
  })
})
