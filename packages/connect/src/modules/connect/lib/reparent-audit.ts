import type { EntityManager } from '@mikro-orm/postgresql'
import { reparentingCursorSchema, type ReparentingCursorInput } from '../data/validators'

/**
 * Cursor codec and item counting for the reparenting audit endpoints.
 *
 * The cursor is base64url over `{ occurredAt, id }` and is re-validated with the
 * same zod schema on the way back in — an opaque-looking string a client can
 * edit is still client input, and it lands in a SQL predicate.
 */

export type ReparentingScope = { tenantId: string; organizationId: string }

export function encodeReparentingCursor(cursor: ReparentingCursorInput): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Returns `null` for anything malformed, so the caller answers 422 rather than throwing. */
export function decodeReparentingCursor(raw: string): ReparentingCursorInput | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    const parsed = reparentingCursorSchema.safeParse(decoded)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

type ItemCountRow = { reparenting_id: string; moved: string | number }

/**
 * Moved-conversation counts for a page of audit rows.
 *
 * One grouped query for the whole page. A per-row count would turn a
 * hundred-entry page into a hundred extra round trips for a number that is only
 * ever rendered as a column.
 */
export async function countReparentingItems(
  em: EntityManager,
  scope: ReparentingScope,
  reparentingIds: readonly string[],
): Promise<Map<string, number>> {
  if (!reparentingIds.length) return new Map()
  const placeholders = reparentingIds.map(() => '?').join(', ')
  const rows = (await em.execute(
    `select "reparenting_id", count(*) as "moved"
       from "connect_case_reparenting_items"
      where "tenant_id" = ? and "organization_id" = ?
        and "reparenting_id" in (${placeholders})
      group by "reparenting_id"`,
    [scope.tenantId, scope.organizationId, ...reparentingIds],
  )) as ItemCountRow[]
  return new Map(rows.map((row) => [row.reparenting_id, Number(row.moved ?? 0)]))
}
