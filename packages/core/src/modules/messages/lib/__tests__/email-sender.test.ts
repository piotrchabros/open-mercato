import {
  createMessageAccessToken,
  sendMessageEmailToExternal,
  sendMessageEmailToRecipient,
} from '../email-sender'

const sendEmailMock = jest.fn(async () => {})
const loadDictionaryMock = jest.fn(async () => ({}))
const createFallbackTranslatorMock = jest.fn(() => (
  (_key: string, fallback?: string) => fallback ?? 'fallback'
))
const messageEmailMock = jest.fn((props: Record<string, unknown>) => ({ props }))

jest.mock('@open-mercato/shared/lib/email/send', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  loadDictionary: (...args: unknown[]) => loadDictionaryMock(...args),
}))

jest.mock('@open-mercato/shared/lib/i18n/translate', () => ({
  createFallbackTranslator: (...args: unknown[]) => createFallbackTranslatorMock(...args),
}))

jest.mock('../../emails/MessageEmail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => messageEmailMock(...args),
}))

function createEm() {
  const flush = jest.fn(async () => {})
  return {
    create: jest.fn((_entity, payload) => payload),
    persist: jest.fn(() => ({ flush })),
    flush,
  }
}

const baseMessage = {
  id: 'message-1',
  subject: 'Subject',
  body: 'Body',
  sentAt: new Date('2026-02-15T10:00:00.000Z'),
} as never

describe('messages email sender', () => {
  const appUrl = process.env.APP_URL

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.APP_URL = 'https://mercato.test/'
  })

  afterAll(() => {
    process.env.APP_URL = appUrl
  })

  it('creates and persists access token as an HMAC hash while returning the raw token', async () => {
    const em = createEm()

    const token = await createMessageAccessToken(
      em as never,
      'message-1',
      'user-1',
    )

    expect(token).toHaveLength(64)
    expect(em.create).toHaveBeenCalledTimes(1)
    expect(em.persist).toHaveBeenCalledTimes(1)
    expect(em.flush).toHaveBeenCalledTimes(1)
    const [, payload] = em.create.mock.calls[0] as [unknown, { token: string }]
    const { hashAuthToken } = require('../../../auth/lib/tokenHash')
    expect(payload.token).toBe(hashAuthToken(token))
    expect(payload.token).not.toBe(token)
  })

  it('sends recipient email with generated view url', async () => {
    const em = createEm()

    await sendMessageEmailToRecipient({
      em: em as never,
      message: baseMessage,
      recipientUserId: 'user-2',
      recipientEmail: 'user2@example.com',
      sender: { name: 'Alice', email: 'alice@example.com' },
      objects: [
        {
          entityModule: 'sales',
          entityType: 'order',
          entityId: 'order-1',
        },
      ] as never,
      attachments: [
        {
          fileName: 'invoice.pdf',
          fileSize: 100,
          mimeType: 'application/pdf',
          partitionCode: 'private',
          storagePath: 'org_shared/tenant_shared/invoice.pdf',
          storageDriver: 'local',
        },
      ],
    })

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user2@example.com',
        subject: 'Subject',
      }),
    )
    expect(messageEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderName: 'Alice',
        viewUrl: expect.stringMatching(/^https:\/\/mercato\.test\/messages\/view\//),
        attachmentNames: ['invoice.pdf'],
        objectLabels: ['sales.order (order-1)'],
      }),
    )
  })

  const recipientParams = (extra: Record<string, unknown> = {}) => ({
    em: createEm() as never,
    message: { ...(baseMessage as object), organizationId: 'org-1' } as never,
    recipientUserId: 'user-2',
    recipientEmail: 'user2@example.com',
    sender: { name: 'Alice', email: 'alice@example.com' },
    objects: [],
    attachments: [],
    ...extra,
  })

  it('prefers the organization app url when the container resolves one', async () => {
    const resolveOwn = jest.fn(async () => 'https://org.example.com')
    const container = { resolve: jest.fn(() => ({ resolveOwn })) }

    await sendMessageEmailToRecipient(recipientParams({ container }))

    expect(resolveOwn).toHaveBeenCalledWith('org-1')
    expect(messageEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        viewUrl: expect.stringMatching(/^https:\/\/org\.example\.com\/messages\/view\//),
      }),
    )
  })

  it('falls back to APP_URL when the organization has no own url', async () => {
    const container = { resolve: jest.fn(() => ({ resolveOwn: async () => null })) }

    await sendMessageEmailToRecipient(recipientParams({ container }))

    expect(messageEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        viewUrl: expect.stringMatching(/^https:\/\/mercato\.test\/messages\/view\//),
      }),
    )
  })

  it('omits the link when APP_URL is missing', async () => {
    delete process.env.APP_URL
    const container = { resolve: jest.fn(() => ({ resolveOwn: async () => 'https://org.example.com' })) }

    await sendMessageEmailToRecipient(recipientParams({ container }))

    expect(messageEmailMock).toHaveBeenCalledWith(expect.objectContaining({ viewUrl: null }))
  })

  it('sends external email without view url', async () => {
    await sendMessageEmailToExternal({
      message: baseMessage,
      email: 'external@example.com',
      sender: { name: null, email: 'sender@example.com' },
      objects: [],
      attachments: [],
    })

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'external@example.com',
        subject: 'Subject',
      }),
    )
    expect(messageEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderName: 'sender@example.com',
        viewUrl: null,
      }),
    )
  })
})
