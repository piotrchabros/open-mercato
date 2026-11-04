export const metadata = {
  requireAuth: true,
  requireFeatures: ['meta_lead_ads.view_logs'],
  pageTitle: 'Meta Lead Ads settings',
  pageTitleKey: 'meta_lead_ads.nav.settings',
  pageGroup: 'Meta Lead Ads',
  pageGroupKey: 'meta_lead_ads.nav.group',
  pageOrder: 30,
  icon: 'settings',
  breadcrumb: [
    { label: 'Meta Lead Ads', labelKey: 'meta_lead_ads.nav.title', href: '/backend/meta-lead-ads' },
    { label: 'Settings', labelKey: 'meta_lead_ads.nav.settings' },
  ],
}
