import handler, { metadata } from '../subscribers/notify-unassigned-transcript'

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/notifications/lib/notificationService', () => ({
  resolveNotificationService: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/notifications/lib/notificationBuilder', () => ({
  buildFeatureNotificationFromType: jest.fn(),
}))

import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveNotificationService } from '@open-mercato/core/modules/notifications/lib/notificationService'
import { buildFeatureNotificationFromType } from '@open-mercato/core/modules/notifications/lib/notificationBuilder'

const payload = {
  id: 'row-1',
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  transcriptId: 'transcript-1',
  reason: 'no_attendees' as const,
}

describe('webhook_calcom notify-unassigned-transcript subscriber', () => {
  const notificationService = { createForFeature: jest.fn(async () => []) }
  const em = {
    fork: jest.fn(function fork() {
      return em
    }),
  }

  beforeEach(() => {
    ;(createRequestContainer as jest.Mock).mockResolvedValue({
      resolve: (name: string) => {
        if (name === 'em') return em
        throw new Error(`Unexpected dependency: ${name}`)
      },
    })
    ;(resolveNotificationService as jest.Mock).mockReturnValue(notificationService)
    ;(buildFeatureNotificationFromType as jest.Mock).mockReturnValue({ type: 'webhook_calcom.unassigned_transcript' })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('is a persistent subscriber for the created event', () => {
    expect(metadata).toEqual({
      event: 'webhook_calcom.unassigned_transcript.created',
      id: 'webhook_calcom:notify-unassigned-transcript',
      persistent: true,
    })
  })

  it('notifies managers of the transcript organization only for a pending row', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue({ id: 'row-1', status: 'pending', title: 'Intro call' })

    await handler(payload)

    expect(findOneWithDecryption).toHaveBeenCalledWith(
      em,
      expect.anything(),
      expect.objectContaining({ id: 'row-1', tenantId: 'tenant-1', organizationId: 'org-1' }),
      {},
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
    expect(buildFeatureNotificationFromType).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'webhook_calcom.unassigned_transcript' }),
      expect.objectContaining({
        requiredFeature: 'webhook_calcom.transcripts.manage',
        bodyVariables: { title: 'Intro call' },
        sourceEntityType: 'webhook_calcom:calcom_unassigned_transcript',
        sourceEntityId: 'row-1',
        groupKey: 'webhook_calcom:unassigned:org-1',
      }),
    )
    expect(notificationService.createForFeature).toHaveBeenCalledWith(
      { type: 'webhook_calcom.unassigned_transcript', restrictRecipientsToOrganization: true },
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
  })

  it('skips when the row is missing', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue(null)
    await handler(payload)
    expect(notificationService.createForFeature).not.toHaveBeenCalled()
  })

  it('skips when the row is no longer pending', async () => {
    ;(findOneWithDecryption as jest.Mock).mockResolvedValue({ id: 'row-1', status: 'resolved', title: 'x' })
    await handler(payload)
    expect(notificationService.createForFeature).not.toHaveBeenCalled()
  })
})
