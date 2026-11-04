import React from 'react'

const metaLeadAdsIcon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
  React.createElement('path', { d: 'M4 6h16' }),
  React.createElement('path', { d: 'M4 12h16' }),
  React.createElement('path', { d: 'M4 18h10' }),
  React.createElement('circle', { cx: 19, cy: 18, r: 2 }),
)

export const metadata = {
  requireAuth: true,
  requireFeatures: ['meta_lead_ads.view_logs'],
  pageTitle: 'Meta Lead Ads',
  pageTitleKey: 'meta_lead_ads.nav.title',
  pageGroup: 'Meta Lead Ads',
  pageGroupKey: 'meta_lead_ads.nav.group',
  pageOrder: 1,
  icon: metaLeadAdsIcon,
  breadcrumb: [{ label: 'Meta Lead Ads', labelKey: 'meta_lead_ads.nav.title' }],
}
