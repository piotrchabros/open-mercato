/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LinkEntityConfirmInput } from '@open-mercato/core/modules/customers/components/linking/LinkEntityDialog'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { AssignTranscriptDialog } from '../components/AssignTranscriptDialog'

const runMutationMock = jest.fn(
  async ({ operation }: { operation: () => Promise<unknown>; context: Record<string, unknown> }) => operation(),
)
const retryLastMutationMock = jest.fn(async () => true)
const confirmErrors: unknown[] = []

jest.mock('@open-mercato/ui/backend/injection/useGuardedMutation', () => ({
  useGuardedMutation: () => ({
    runMutation: runMutationMock,
    retryLastMutation: retryLastMutationMock,
  }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: jest.fn() }))
jest.mock('@open-mercato/ui/backend/conflicts', () => ({ surfaceRecordConflict: jest.fn(() => true) }))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) => {
    const template = fallback ?? key
    return params
      ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
      : template
  },
}))

jest.mock('@open-mercato/core/modules/customers/components/linking/adapters/personAdapter', () => ({
  createPersonLinkAdapter: (options: Record<string, unknown>) => ({ kind: 'person', ...options }),
}))

jest.mock('@open-mercato/core/modules/customers/components/linking/LinkEntityDialog', () => ({
  LinkEntityDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: (input: LinkEntityConfirmInput) => Promise<void>
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          onConfirm({
            addedIds: ['person-1'],
            removedIds: [],
            nextSelectedIds: ['person-1'],
            optionsById: { 'person-1': { id: 'person-1', label: 'Ada Lovelace' } },
          }).catch((err: unknown) => {
            confirmErrors.push(err)
          })
        }}
      >
        confirm-selection
      </button>
    ) : null,
}))

const transcript = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Discovery call',
  updatedAt: '2026-11-04T10:00:00.000Z',
}

class TestResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: Headers
  private readonly bodyText: string

  constructor(body: string | null = null, init: ResponseInit = {}) {
    this.bodyText = body ?? ''
    this.status = init.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    this.headers = new Headers(init.headers)
  }

  async text(): Promise<string> {
    return this.bodyText
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText)
  }

  clone(): TestResponse {
    return new TestResponse(this.bodyText, { status: this.status, headers: this.headers })
  }
}

if (typeof globalThis.Response === 'undefined') {
  Object.defineProperty(globalThis, 'Response', { value: TestResponse, configurable: true, writable: true })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function readHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('AssignTranscriptDialog', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    confirmErrors.length = 0
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('posts the selected person with the optimistic-lock header and reports success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        interactionId: 'interaction-1',
        attachmentId: 'attachment-1',
        resolvedEntityId: 'person-1',
        assignedToDifferentPerson: false,
      }),
    )
    const onAssigned = jest.fn()
    render(<AssignTranscriptDialog open onOpenChange={jest.fn()} transcript={transcript} onAssigned={onAssigned} />)

    fireEvent.click(screen.getByText('confirm-selection'))

    await waitFor(() => expect(onAssigned).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/webhook_calcom/unassigned-transcripts/${transcript.id}/assign`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ personId: 'person-1' })
    expect(readHeader(init, OPTIMISTIC_LOCK_HEADER_NAME)).toBe(transcript.updatedAt)
    expect(runMutationMock.mock.calls[0][0].context).toEqual(
      expect.objectContaining({ resourceId: transcript.id, retryLastMutation: retryLastMutationMock }),
    )
    expect(onAssigned).toHaveBeenCalledWith(expect.objectContaining({ resolvedEntityId: 'person-1' }), 'Ada Lovelace')
    expect(flash).toHaveBeenCalledWith('Transcript assigned to Ada Lovelace', 'success')
  })

  it('explains when the transcript landed on another contact', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        interactionId: 'interaction-1',
        attachmentId: 'attachment-1',
        resolvedEntityId: 'person-2',
        assignedToDifferentPerson: true,
      }),
    )
    const onAssigned = jest.fn()
    render(<AssignTranscriptDialog open onOpenChange={jest.fn()} transcript={transcript} onAssigned={onAssigned} />)

    fireEvent.click(screen.getByText('confirm-selection'))

    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith(expect.anything(), null))
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('already linked to another contact'), 'warning')
  })

  it('surfaces an optimistic-lock conflict instead of a generic error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: 'Record modified',
        code: 'optimistic_lock_conflict',
        currentUpdatedAt: '2026-11-04T11:00:00.000Z',
        expectedUpdatedAt: transcript.updatedAt,
      }),
    )
    const onAssigned = jest.fn()
    render(<AssignTranscriptDialog open onOpenChange={jest.fn()} transcript={transcript} onAssigned={onAssigned} />)

    fireEvent.click(screen.getByText('confirm-selection'))

    await waitFor(() => expect(surfaceRecordConflict).toHaveBeenCalled())
    const [error] = (surfaceRecordConflict as jest.Mock).mock.calls[0] as [{ status?: number; code?: string }]
    expect(error.status).toBe(409)
    expect(error.code).toBe('optimistic_lock_conflict')
    await waitFor(() => expect(confirmErrors).toHaveLength(1))
    expect(onAssigned).not.toHaveBeenCalled()
    expect(flash).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('flashes the server message when the conflict is not an optimistic-lock one', async () => {
    ;(surfaceRecordConflict as jest.Mock).mockReturnValueOnce(false)
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'This transcript has already been handled' }))
    render(<AssignTranscriptDialog open onOpenChange={jest.fn()} transcript={transcript} />)

    fireEvent.click(screen.getByText('confirm-selection'))

    await waitFor(() => expect(flash).toHaveBeenCalledWith('This transcript has already been handled', 'error'))
  })
})
