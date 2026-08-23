import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Atomic per-organization Case number allocation.
 *
 * The previous rule was `max(number) + 1`, which is a read, not an allocation.
 * Two openers racing — an inbound message and a supervisor splitting a Case, say
 * — both read the same maximum, both claim it, and one dies on the unique
 * constraint after doing all its other work. Under load that is not rare.
 *
 * This helper upserts the scope's sequence row, locks it FOR UPDATE, and hands
 * out `next_number` inside the CALLER's transaction. Concurrent allocators queue
 * on the row lock instead of colliding, and the number is released only when the
 * caller's transaction ends — so a rolled-back open leaves no gap it could have
 * avoided and, more importantly, no duplicate.
 */

export type CaseNumberScope = {
  tenantId: string
  organizationId: string
}

/**
 * Allocate the next Case number for a scope.
 *
 * MUST be called inside a transaction. Claim and advance happen in ONE statement
 * because any gap between them — even a `select ... for update` followed by an
 * `update` — is a window a second allocator can enter. `ON CONFLICT DO UPDATE`
 * (rather than `DO NOTHING`) is what makes the single statement possible: it
 * returns and row-locks the existing sequence, where `DO NOTHING` would return
 * nothing and force a second round trip.
 *
 * Seeding at `2` on insert is not an off-by-one: the inserting caller is taking
 * number 1, so the next value to hand out is 2.
 */
export async function allocateConnectCaseNumber(
  em: EntityManager,
  scope: CaseNumberScope,
): Promise<number> {
  const rows = (await em.execute(
    `insert into "connect_case_number_sequences"
        ("tenant_id", "organization_id", "next_number", "created_at", "updated_at")
     values (?, ?, 2, now(), now())
     on conflict ("tenant_id", "organization_id") do update
        set "next_number" = "connect_case_number_sequences"."next_number" + 1,
            "updated_at" = now()
     returning "next_number" - 1 as "allocated"`,
    [scope.tenantId, scope.organizationId],
  )) as Array<{ allocated: number | string }>

  const value = Number(rows[0]?.allocated ?? 0)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('[internal] connect_case_number_allocation_failed')
  }
  return value
}
