export const metadata = {
  requireAuth: true,
  requireFeatures: ['meta_lead_ads.view_logs'],
  pageTitle: 'Recent leads',
  pageTitleKey: 'meta_lead_ads.nav.leads',
  pageGroup: 'Meta Lead Ads',
  pageGroupKey: 'meta_lead_ads.nav.group',
  pageOrder: 20,
  icon: 'list-checks',
  breadcrumb: [
    { label: 'Meta Lead Ads', labelKey: 'meta_lead_ads.nav.title', href: '/backend/meta-lead-ads' },
    { label: 'Recent leads', labelKey: 'meta_lead_ads.nav.leads' },
  ],
}
