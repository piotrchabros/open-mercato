export const metadata = {
  requireAuth: true,
  requireFeatures: ['offer_generator.manage'],
  pageTitle: 'New offer',
  pageTitleKey: 'offer_generator.create.title',
  navHidden: true,
  breadcrumb: [
    { label: 'Offers', labelKey: 'offer_generator.nav.title', href: '/backend/offer-generator' },
    { label: 'New offer', labelKey: 'offer_generator.create.title' },
  ],
}
