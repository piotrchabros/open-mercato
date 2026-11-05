export const metadata = {
  requireAuth: true,
  requireFeatures: ['offer_generator.settings.manage'],
  pageTitle: 'Offer settings',
  pageTitleKey: 'offer_generator.nav.settings',
  pageGroup: 'Offers',
  pageGroupKey: 'offer_generator.nav.group',
  pageOrder: 30,
  icon: 'settings',
  breadcrumb: [
    { label: 'Offers', labelKey: 'offer_generator.nav.title', href: '/backend/offer-generator' },
    { label: 'Settings', labelKey: 'offer_generator.nav.settings' },
  ],
}
