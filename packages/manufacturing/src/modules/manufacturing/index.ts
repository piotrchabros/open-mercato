/**
 * Manufacturing Module Entry Point
 *
 * Exposes module metadata. Spec: .ai/specs/2026-07-18-manufacturing-planning-module.md
 */

// Import events to register typed event declarations
import './events.js'

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'manufacturing',
  title: 'Manufacturing',
  description: 'Manufacturing planning: BOMs, routings, work centers, manufacturing orders, MRP, shop-floor reporting',
  version: '0.1.0',
}
