export const features = [
  { id: 'customer_accounts.view', title: 'View customer accounts', module: 'customer_accounts' },
  { id: 'customer_accounts.manage', title: 'Manage customer accounts', module: 'customer_accounts' },
  { id: 'customer_accounts.roles.manage', title: 'Manage customer roles', module: 'customer_accounts' },
  { id: 'customer_accounts.invite', title: 'Invite customer users', module: 'customer_accounts' },
  { id: 'customer_accounts.domain.manage', title: 'Manage custom portal domains', module: 'customer_accounts' },
  // Separate from domain.manage on purpose (#4271): a backend domain decides
  // which organization an operator acts on, so registering one is a strictly
  // higher privilege than pointing a storefront at a hostname.
  {
    id: 'customer_accounts.domain.manage_backend',
    title: 'Manage custom backend (admin) domains',
    module: 'customer_accounts',
  },
]

export default features
