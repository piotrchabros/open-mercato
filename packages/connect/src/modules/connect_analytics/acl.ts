/**
 * Connect analytics access control.
 *
 * One feature, because there is exactly one act: reading aggregate operational
 * reports. It is independently gated rather than folded into
 * `connect.metrics.view` so that disabling analytics never narrows the existing
 * Phase 1 grant, and so an organization can publish trend reporting to managers
 * without also handing them the rebuild surface.
 *
 * Agent-grain reporting is deliberately absent: the facts carry no sanctioned
 * agent dimension, and a feature ID that nothing enforces is a grant that
 * silently means nothing.
 */
export const features = [
  {
    id: 'connect_analytics.view',
    title: 'View Connect operational analytics reports',
    module: 'connect_analytics',
  },
] as const

export default features
