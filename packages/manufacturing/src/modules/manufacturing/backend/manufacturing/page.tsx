'use client'

import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Manufacturing module landing page. Phase 1 replaces this overview with the
 * technology and orders surfaces; the scaffold ships it so the module has a
 * visible, toggle-gated entry point (task 0.2 DoD).
 */
export default function ManufacturingOverviewPage() {
  const t = useT()

  return (
    <div className="flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold text-foreground">
        {t('manufacturing.overview.title', 'Manufacturing planning')}
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t(
          'manufacturing.overview.description',
          'Plan and record manufacturing: technology (BOMs, routings, work centers), manufacturing orders, material requirements planning, and shop-floor reporting arrive in the upcoming phases of this module.',
        )}
      </p>
    </div>
  )
}
