import type { EntityExtension } from '@open-mercato/shared/modules/entities'

/**
 * Cross-module entity links declared by the manufacturing module.
 *
 * Manufacturing knows about planner's availability rule sets (spec decision *a*:
 * work centers reuse planner calendars for capacity availability), but
 * planner does NOT know about manufacturing — dependency direction is one-way
 * (manufacturing → planner). Lookups across this link happen via the query
 * engine, never via raw SQL joins.
 *
 * Canonical EntityExtension shape from `@open-mercato/shared/modules/entities`:
 *   `{ base, extension, join: { baseKey, extensionKey }, cardinality?, required?, description? }`
 */

const entityExtensions: EntityExtension[] = [
  {
    base: 'planner:planner_availability_rule_set',
    extension: 'manufacturing:work_center',
    join: { baseKey: 'id', extensionKey: 'availability_rule_set_id' },
    cardinality: 'one-to-many',
    required: false,
    description: 'Work center capacity availability reuses a planner rule set; default 24/7 when absent',
  },
]

export const extensions = entityExtensions
export default entityExtensions
