/** @jest-environment node */

/**
 * Organization switcher on a bound host (#4271, task 3.8).
 *
 * This layer is PRESENTATION. `om_selected_org` is written by client
 * JavaScript, so hiding a dropdown constrains nobody — enforcement lives in the
 * auth clamp (3.4) and the scope resolver (3.5), both of which answer a
 * mismatching selection with 403. What is pinned here is only that the server
 * stops advertising choices it will refuse.
 */
import { applyHostBoundSwitcherView } from '@open-mercato/core/modules/directory/api/organization-switcher/route'

const TENANTS = [{ id: 't1' }, { id: 't2' }]

describe('applyHostBoundSwitcherView', () => {
  it('passes everything through untouched on an unbound host', () => {
    const view = applyHostBoundSwitcherView({
      hostBinding: null,
      canViewAllOrganizations: true,
      tenants: TENANTS,
    })

    expect(view).toEqual({
      canViewAllOrganizations: true,
      tenants: TENANTS,
      hostBoundOrganizationId: null,
    })
  })

  it('withdraws the all-organizations option on a bound host', () => {
    // A super-admin resolves to canViewAllOrganizations: true by default;
    // leaving it would offer a widening the scope resolver rejects.
    const view = applyHostBoundSwitcherView({
      hostBinding: { organizationId: 'org-bound' },
      canViewAllOrganizations: true,
      tenants: TENANTS,
    })

    expect(view.canViewAllOrganizations).toBe(false)
  })

  it('withdraws the tenant picker on a bound host', () => {
    const view = applyHostBoundSwitcherView({
      hostBinding: { organizationId: 'org-bound' },
      canViewAllOrganizations: true,
      tenants: TENANTS,
    })

    expect(view.tenants).toEqual([])
  })

  it('reports which organization the hostname pins', () => {
    const view = applyHostBoundSwitcherView({
      hostBinding: { organizationId: 'org-bound' },
      canViewAllOrganizations: false,
      tenants: [],
    })

    expect(view.hostBoundOrganizationId).toBe('org-bound')
  })
})
