/** @jest-environment node */
jest.mock('#generated/entities.ids.generated', () => ({ E: { attachments: { attachment: 'attachments:attachment' } } }), { virtual: true })

import { createAttachmentFromBuffer } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'

const mockStore = jest.fn(async () => ({ storagePath: 'p/file.txt' }))

jest.mock('@open-mercato/core/modules/attachments/lib/drivers', () => ({
  StorageDriverFactory: jest.fn().mockImplementation(() => ({
    resolveForPartition: jest.fn(async () => ({ store: mockStore })),
  })),
}))
jest.mock('@open-mercato/core/modules/attachments/lib/access-protection', () => ({
  ensureAttachmentPartitionProtection: jest.fn(async () => undefined),
}))

function makeEm() {
  const created: Array<Record<string, any>> = []
  const em: any = {
    findOne: jest.fn(async () => ({ code: 'default', storageDriver: 'local' })),
    create: jest.fn((_entity: unknown, data: Record<string, any>) => {
      created.push(data)
      return data
    }),
    transactional: jest.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ persist: () => ({ flush: async () => undefined }) }),
    ),
  }
  return { em, created }
}

const baseInput = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  entityId: 'customers:deal',
  recordId: 'deal-1',
  fileName: 'a.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello'),
}

describe('createAttachmentFromBuffer assignments', () => {
  it('stores only the primary assignment by default', async () => {
    const { em, created } = makeEm()
    await createAttachmentFromBuffer({ em, ...baseInput })
    expect(created[0].storageMetadata.assignments).toEqual([{ type: 'customers:deal', id: 'deal-1' }])
  })

  it('folds additional assignments in and dedupes them', async () => {
    const { em, created } = makeEm()
    await createAttachmentFromBuffer({
      em,
      ...baseInput,
      additionalAssignments: [
        { type: 'customers:person', id: 'person-1', label: 'Jane' },
        { type: 'customers:deal', id: 'deal-1' },
        { type: 'customers:person', id: 'person-1', label: 'Jane' },
      ],
    })
    const assignments = created[0].storageMetadata.assignments
    expect(assignments).toHaveLength(2)
    expect(assignments).toEqual(
      expect.arrayContaining([
        { type: 'customers:deal', id: 'deal-1' },
        { type: 'customers:person', id: 'person-1', label: 'Jane' },
      ]),
    )
  })
})
