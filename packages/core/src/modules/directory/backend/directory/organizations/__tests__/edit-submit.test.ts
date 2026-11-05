jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: () => null,
}))

import { submitUpdateOrganization } from '../[id]/edit/page'

describe('submitUpdateOrganization', () => {
  it('throws when organization identifier is missing', async () => {
    const error = await submitUpdateOrganization({
      values: { name: 'Acme' },
      orgId: '',
      tenantId: null,
      originalChildIds: [],
      updateOrganization: async () => {},
    }).catch((err) => err as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      message: 'Organization identifier is required',
      fieldErrors: { id: 'Organization identifier is required' },
    })
  })

  it('passes sanitized payload to updateOrganization', async () => {
    const updateOrganization = jest.fn(async () => {})
    await submitUpdateOrganization({
      values: {
        id: 'org-1',
        name: 'Acme',
        isActive: true,
        parentId: 'parent-1',
        tenantId: 'tenant-1',
        cf_custom: 'value',
      },
      orgId: 'org-1',
      tenantId: 'tenant-1',
      originalChildIds: ['child-1', 'child-2'],
      updateOrganization,
    })
    expect(updateOrganization).toHaveBeenCalledWith({
      id: 'org-1',
      name: 'Acme',
      isActive: true,
      parentId: 'parent-1',
      childIds: ['child-1', 'child-2'],
      tenantId: 'tenant-1',
      customFields: { custom: 'value' },
    })
  })

  it('includes a trimmed appUrl when includeAppUrl is true', async () => {
    const updateOrganization = jest.fn(async () => {})
    await submitUpdateOrganization({
      values: { id: 'org-1', name: 'Acme', appUrl: ' https://crm.example.com ' },
      orgId: 'org-1',
      tenantId: 'tenant-1',
      originalChildIds: [],
      includeAppUrl: true,
      updateOrganization,
    })
    expect(updateOrganization).toHaveBeenCalledWith(expect.objectContaining({ appUrl: 'https://crm.example.com' }))
  })

  it('sends null appUrl when cleared and includeAppUrl is true', async () => {
    const updateOrganization = jest.fn(async () => {})
    await submitUpdateOrganization({
      values: { id: 'org-1', name: 'Acme', appUrl: '' },
      orgId: 'org-1',
      tenantId: 'tenant-1',
      originalChildIds: [],
      includeAppUrl: true,
      updateOrganization,
    })
    expect(updateOrganization).toHaveBeenCalledWith(expect.objectContaining({ appUrl: null }))
  })

  it('omits appUrl when includeAppUrl is false', async () => {
    const updateOrganization = jest.fn(async () => {})
    await submitUpdateOrganization({
      values: { id: 'org-1', name: 'Acme', appUrl: 'https://crm.example.com' },
      orgId: 'org-1',
      tenantId: 'tenant-1',
      originalChildIds: [],
      includeAppUrl: false,
      updateOrganization,
    })
    expect(updateOrganization.mock.calls[0][0]).not.toHaveProperty('appUrl')
  })
})
