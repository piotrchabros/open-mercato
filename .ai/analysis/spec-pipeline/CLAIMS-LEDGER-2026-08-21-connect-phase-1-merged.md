# Claims ledger — `.ai/specs/2026-08-21-connect-phase-1-merged.md`

**Verified by:** cez/486d110a implementation session (independent agent)
**Author of the claims:** the merged-spec authoring agent
**UNGATED:** no — verifier ≠ author
**Method:** [`.ai/skills/om-verify-spec-claims/SKILL.md`](../../skills/om-verify-spec-claims/SKILL.md)
**Checkout:** worktree at `c0e50a8fa`, deps installed, all citations re-opened

Falsifiers were written before the corresponding code path was opened.

| # | Claim (as written in the spec) | Where asserted | Code path that PERFORMS it | Falsifier | Verdict |
|---|---|---|---|---|---|
| 1 | Every strategy in `thread-matcher.ts` filters by `channelId` (`:110`, `:128`, `:150`, `:174`) | Provenance repair 1 | `communication_channels/lib/thread-matcher.ts:97-186` — all four strategies pass `channelId: input.channelId`; `resolveTokenThread`'s header comment states the intra-channel rule explicitly | any strategy whose query omits `channelId` | **CONFIRMED** |
| 2 | `ingest-inbound-message.ts:402` writes `messageThreadId: message.threadId ?? message.id` seeded from that channel-scoped match | Provenance repair 1 | `communication_channels/commands/ingest-inbound-message.ts:402`, sibling `channelId: input.channelId` at `:403` | the id derives from something channel-independent | **CONFIRMED** (line-exact) |
| 3 | `channel_thread_mappings` is unique on `(external_conversation_id, tenant_id)`; `messageThreadId` carries only an index | Provenance repair 1 | `communication_channels/data/entities.ts:325` `@Unique channel_thread_mappings_ext_conv_uq`; `:324` `@Index channel_thread_mappings_thread_idx` | a unique constraint on `messageThreadId` | **CONFIRMED** |
| 4 | `send-as-user.ts:101-103` returns 403 "You can only send through channels you own" when `channel.userId !== actor.userId` | Provenance repair 2 | `communication_channels/lib/send-as-user.ts:101-103` | check absent, warn-only, or an in-process bypass | **CONFIRMED** (line-exact) |
| 5 | `messages` has no `di.ts` at all | § Reading peer data | absence verified: `packages/core/src/modules/messages/` has no `di.ts` | a `di.ts` in that directory | **CONFIRMED** |
| 6 | `communication_channels/di.ts` registers entity classes as an EntityManager convenience; `communicationChannelsSendAsUser` is the in-process facade precedent | § Reading peer data | `communication_channels/di.ts:23` comment verbatim; `:38` `communicationChannelsSendAsUser: asValue(sendAsUser)` | comment absent, or no facade registration | **CONFIRMED** (verbatim) |
| 7 | `messages.Message.senderUserId` is NOT NULL | Core-edit ledger, PR A, § Migration | `messages/data/entities.ts:53-54` `@Property({ name: 'sender_user_id', type: 'uuid' })` with `senderUserId!: string`; snapshot `"nullable": false` | `nullable: true` on property or column | **CONFIRMED** |
| 8 | `system-user.ts` returns a sentinel UUID with **no `auth.users` row**, **so the column cannot be satisfied for system-authored sends** | Core-edit ledger row 3 (justifies the (d)-class change and Q2) | see § Load-bearing failure below | a shipped path that already writes a system-authored `senderUserId` and succeeds | **REFUTED** |
| 9 | `CustomerInteraction.entity` is a non-nullable `@ManyToOne` | FR-018, T-PROJ-02 | `customers/data/entities.ts` — `@ManyToOne(() => CustomerEntity, { fieldName: 'entity_id' })` / `entity!: CustomerEntity`, no `nullable` | `nullable: true` on the relation | **CONFIRMED** |
| 10 | `requireTimelineParentEntity` rejects any kind outside `{person, company}` | FR-018, T-PROJ-02 | `customers/commands/shared.ts:69-71` throws `CrudHttpError(422)`; `:80-82` rejects deals; `:83` notFound | a default-allow branch, or acceptance of another kind | **CONFIRMED** |
| 11 | `hashField` is the platform mechanism, used by `auth`, `customer_accounts` and `messages` | § Encryption, T-DATA-03 | `auth/encryption.ts:7`; `customer_accounts/encryption.ts:7,21`; `messages/encryption.ts:9` | no `hashField` key in those maps | **CONFIRMED** |
| 12 | The entity-level `updated_at` gate resolves `__dirname/../modules/<id>` — `packages/core` only — while the other two opt-lock gates scan every workspace package | Core-edit ledger, T-DATA-05 | `optimistic-lock-editable-entities.test.ts:72` `join(__dirname,'..','modules',moduleId,...)`; `optimistic-lock-ui-coverage-workspace.test.ts:8-9` and `optimistic-lock-command-coverage.test.ts:7` both scan every package | the entity test resolving workspace-wide paths | **CONFIRMED** |
| 13 | `customers.interactions.create` is already called cross-module from `example_customers_sync/lib/sync.ts:854` | PR B rationale | `apps/mercato/src/modules/example_customers_sync/lib/sync.ts:859` (**line drift: :859, not :854**) | no cross-module caller of that command | **CONFIRMED** (wrong line, harmless) |
| 14 | `customers.interactions.create` creates and flushes unconditionally and forks its own EM, so resolve + projection cannot be atomic | T-PROJ-01 | `customers/commands/interactions.ts:382` `.fork()`; `:423` `await trx.flush()` inside `runInTransaction` | the command joining a caller-supplied transaction | **CONFIRMED** |
| 15 | `inbox_ops/lib/rateLimiter.ts` cannot be reused as-is: two call sites key on a global and a tenant bucket; cache keys hardcoded to the `inbox_ops:` namespace | R1, slice 1b | `inbox_ops/lib/rateLimiter.ts:74,96` `` `inbox_ops:rate_limit:${key}` ``; only non-test call sites are `api/webhook/inbound.ts:294` (global) and `:339` (tenant) | a third call site, or a configurable namespace | **CONFIRMED** — narrowed: `key` *is* caller-supplied, so a `(channel_id, from_handle_hash)` bucket is expressible; the blocker is the hardcoded namespace and the absent call site, not the signature |
| 16 | `communication_channels/data/extensions.ts` already declares `{ base: 'auth:user', extension: 'communication_channels:communication_channel', join: { baseKey: 'id', extensionKey: 'user_id' } }` | § No `auth.User` column | `communication_channels/data/extensions.ts:51-53` verbatim | the declaration absent or differently shaped | **CONFIRMED** (verbatim) |
| 17 | `BACKWARD_COMPATIBILITY.md` has **14** surfaces; `om-pre-implement-spec`'s table says 13 and is stale; #12 is AI Agent/Tool/UI Part/Override IDs (FROZEN) | § Migration & BC | `BACKWARD_COMPATIBILITY.md` §§1-14, `### 12. AI Agent, Tool, UI Part, and Override IDs (FROZEN / STABLE)` at `:213`; `om-pre-implement-spec/SKILL.md:15,23` says 13 | a 13th-and-final surface, or #12 being something else | **CONFIRMED** |
| 18 | `assertCanManageChannel`'s shared branch already requires an elevated feature, so a caller-supplied `allowSharedChannel` flag is unnecessary | § Blocking upstream PRs | `communication_channels/lib/access-control.ts:96-99` — `userId == null` branch calls `authorizeFeatures([elevatedFeature], …)` | the shared branch permitting access without a feature | **CONFIRMED** |
| 19 | `lookupHashCandidates` is the read-side hash lookup | T-ING-03 | `packages/shared/src/lib/encryption/aes.ts:159` | function absent | **CONFIRMED** |
| 20 | `runMutationGuards` + `bridgeLegacyGuard` are the guard-registry mechanism for non-CRUD write routes | § API contracts | `packages/shared/src/lib/crud/mutation-guard-registry.ts:90,129` | either export absent | **CONFIRMED** |
| 21 | `case_number` follows the `sales.SalesDocumentSequence` pattern | § Data model | `sales/data/entities.ts:794` `class SalesDocumentSequence` | entity absent | **CONFIRMED** |
| 22 | `packages/content/` is a valid mirror for new-package scaffolding | T-SET-01 | `packages/content/package.json`, `packages/content/tsconfig.json` | package absent or not a module package | **CONFIRMED** |
| 23 | `frozen-surfaces.md` lists `connect.identities.manage` among six Phase-1 ACL IDs and ten `connect.*` event IDs — so the spec's two drift reconciliations are correct | § Frozen-surface drift | `.ai/specs/app-spec-notes/frozen-surfaces.md:68-70` (six ACL IDs incl. `connect.identities.manage`), `:42,46-49` (ten event IDs) | either list disagreeing with the spec's resolution | **CONFIRMED** |

**CONFIRMED: 22  ·  OVERSTATED: 0  ·  REFUTED: 1  ·  UNCITABLE: 0  ·  rows: 23**

---

## Load-bearing failure — row 8

**What the spec concluded.** Core-edit ledger row 3 classifies "`messages` — `senderUserId` NOT NULL
relaxed" as a **(d)** entity/table change requiring a separate upstream PR and a maintainer
sign-off (Q2), on this justification:

> "An extension entity cannot relax a NOT NULL on the base table.
> `communication_channels/lib/system-user.ts` returns a sentinel UUID with **no `auth.users` row**,
> so the column cannot be satisfied for system-authored sends."

That justification makes Q2 a blocker on upstream PR A, which in turn blocks slice 1c.

**What is actually true.** The column is already satisfied for system-authored sends today, by the
mechanism the spec cites as the obstacle.

1. **There is no foreign key.** `sender_user_id` is a plain `@Property({ type: 'uuid' })`, not a
   `@ManyToOne` (`messages/data/entities.ts:53-54`). The create-table SQL declares exactly one
   constraint — `constraint "messages_pkey" primary key ("id")`
   (`messages/migrations/Migration20260213181243.ts:6`) — and the ORM snapshot records
   `"foreignKeys": {}` for the `messages` table. A repo-wide sweep of every module's migrations
   finds no `alter table … add constraint … foreign key` touching `sender_user_id`.
   **A `uuid NOT NULL` column with no FK is satisfied by any valid UUID, including the sentinel.**
   The absence of an `auth.users` row is therefore irrelevant to the constraint.

2. **The shipped inbound path already does exactly this.**
   `communication_channels/commands/ingest-inbound-message.ts:378` builds its compose input with
   `userId: await resolveCommunicationChannelsSystemUserId(em, input.scope.tenantId, mapping?.assignedUserId ?? null)`,
   and `messages/commands/messages.ts:316` writes that through as `senderUserId: input.userId`.
   When no per-tenant channel-bot user exists, that resolves to
   `COMMUNICATION_CHANNELS_SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'`. System-authored
   messages with no backing `auth.users` row are **an existing, shipped, tested state**.

3. **Consumers already degrade gracefully.** `messages/lib/forwarding.ts:208,218` does
   `userById.get(item.senderUserId)` and renders `formatUserLabel(sender, item.senderUserId)` —
   a fallback label when the lookup misses, not a hard failure.

4. **The sentinel is a last resort, not the normal return.** The spec's phrasing ("returns a
   sentinel UUID") understates `resolveCommunicationChannelsSystemUserId`, whose documented lookup
   order is (1) per-tenant channel-bot user by convention e-mail, (2) caller-supplied fallback id,
   (3) sentinel. Its header comment explicitly invites implementations to "create a real `auth.user`
   row matching this convention".

5. **The shared-channel outbound case does not need it either.** For an agent replying from a shared
   mailbox the actor is a real human: `send-as-user.ts:146` passes `userId: actor.userId` into
   compose. `senderUserId` is a real user id on that path regardless.

**What the plan now owes.**

- The `senderUserId` NOT NULL relaxation is **not required** by the mechanism the spec cites. It may
  still be *preferred* — `NULL` is semantically cleaner than a magic UUID — but that is a design
  preference, not a constraint the platform imposes, and the spec presents it as the latter.
- With the row struck, **PR A carries no (d)-class change**, the core-edit ledger drops from 2
  (d)/(e) rows to 1 (the `send-as-user.ts` (e) row, which stands), and **Q2's maintainer sign-off is
  no longer a blocker on slice 1c**.
- The spec's § Migration & backward compatibility "Changed:" line must drop the surface-8
  ADDITIVE-ONLY entry; only the surface-3 `SendMessageInput` change remains.

**Anti-evidence pattern hit.** Pattern 4 — *"the function exists"* / inverted: the spec read
`system-user.ts`'s sentinel as proof the column *could not* be satisfied, without opening the caller
(`ingest-inbound-message.ts:378`) that satisfies it. An absence claim ("cannot be satisfied") was
assigned without looking for the writer that already does. This is the same class the skill warns
about in patterns 1+2, applied to an absence rather than a presence.

## Anti-evidence patterns hit across the ledger

Only one row failed, so there is no systematic reading error. Two minor precision notes, neither
load-bearing:

- **Pattern 10 (a count/citation quoted without re-derivation)** — row 13's `sync.ts:854` is
  `:859` in this checkout. Inherited unchanged from ANALYSIS-054, which also says `:854`.
- **Row 15** is confirmed but was stated more broadly than the code supports; ANALYSIS-054 already
  flagged the same overreach. The narrowing is recorded in the row.
