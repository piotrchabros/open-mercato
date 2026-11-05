export const metadata = {
  requireAuth: true,
  requireFeatures: ['offer_generator.view'],
  pageTitle: 'Offer',
  pageTitleKey: 'offer_generator.detail.title',
  navHidden: true,
  breadcrumb: [
    { label: 'Offers', labelKey: 'offer_generator.nav.title', href: '/backend/offer-generator' },
    { label: 'Offer', labelKey: 'offer_generator.detail.title' },
  ],
}
