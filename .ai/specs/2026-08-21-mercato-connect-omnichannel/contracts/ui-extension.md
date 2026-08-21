# UI Extension Contract: Mercato Connect

Conventions in [README.md](./README.md). Host spot-id conventions: `packages/core/AGENTS.md` § Widget Injection. Component rules: `packages/ui/AGENTS.md` and `.ai/ds-rules.md`.

## Design-system compliance

The prototype styles everything inline. That is a prototyping artefact — **none of it ships**. Implementation uses `packages/ui` primitives and DS tokens:

| Prototype inline style | Ships as |
|---|---|
| `background:var(--status-error-icon)` on SLA text | `text-status-error-icon` token class via a shared `SlaBadge` |
| Hand-rolled `<button>` toggles | `Switch` / `SwitchField` (`@open-mercato/ui/primitives/switch`) |
| Hand-rolled avatar `<div class="rounded-full">` | `Avatar` / `AvatarStack` |
| Hand-rolled pill filters | `SegmentedControl` or `Tag` per selection semantics |
| Hand-rolled `<table>` | `DataTable` |
| Inline progress bars | `Progress` / `CircularProgress` |
| Inline timeline | `ActivityFeed` |
| Inline toast | shared `flash()` |
| `font-size:13px` etc. | DS type scale — no arbitrary values |

Hard rules restated because the prototype violates all three: no hardcoded Tailwind status colours (`text-red-*`), no arbitrary values (`text-[13px]`, `z-[9999]`), no `dark:` overrides on semantic or status tokens.

## Backend pages

| Path | Screen | Guard |
|---|---|---|
| `conversations/backend/inbox/page.tsx` | Inbox (3-pane) | `conversations.view` |
| `conversations/backend/customers/[id]/page.tsx` | Customer 360 | `conversations.view` |
| `service_tickets/backend/tickets/page.tsx` | Cases list | `service_tickets.view` |
| `contact_queues/backend/wallboard/page.tsx` | Wallboard | `contact_queues.wallboard.view` |
| `contact_analytics/backend/dashboard/page.tsx` | KPI dashboard | `contact_analytics.view` |
| `contact_campaigns/backend/campaigns/page.tsx` | Campaigns & dialer | `contact_campaigns.view` |
| `bot_intents/backend/bots/page.tsx` | AI bots | `bot_intents.view` |
| `telephony/backend/flows/page.tsx` | IVR & flows | `telephony.view` |
| `contact_quality/backend/quality/page.tsx` | Contact quality | `contact_quality.view` |
| `conversations/backend/ai/page.tsx` | AI programme oversight | `conversations.view` |
| `conversations/backend/settings/page.tsx` | Suite settings (modules, channels, rules) | `configs.manage` |

Each ships `page.meta.ts` with `requireAuth` + `requireFeatures` and a `nav` block. Nav grouping matches the spec: service / traffic / analytics / configuration (FR-003).

## Portal pages

| Path | Purpose | Metadata |
|---|---|---|
| `conversations/frontend/[orgSlug]/portal/cases/page.tsx` | Case list + status (FR-066) | `requireCustomerAuth`, `requireCustomerFeatures: ['portal.cases.view']`, `nav` present |
| `conversations/frontend/[orgSlug]/portal/cases/[id]/page.tsx` | Case detail, history, offered resolutions (FR-067, FR-068) | same features, **no** `nav` block (detail page) |
| `service_tickets/frontend/[orgSlug]/portal/self-service/page.tsx` | Return/exchange, invoice, reschedule (FR-069) | `requireCustomerFeatures: ['portal.selfservice.use']`, `nav` present |

`[orgSlug]` MUST be the first segment. Granting the customer-role feature is sufficient for the nav entry to appear — no menu-injection widget needed.

## DataTable ids

Stable ids; deep-extension spots derive from them (`data-table:<id>:columns`, `:row-actions`, `:bulk-actions`, `:filters`, `:toolbar`, `:search-trailing`).

`conversations:inbox` · `service_tickets:tickets` · `contact_queues:queues` · `contact_queues:agents` · `contact_campaigns:campaigns` · `bot_intents:intents` · `contact_quality:reviews` · `telephony:calls` · `contact_analytics:agent-performance`

## CrudForm entity ids

Field-injection spots are `crud-form:<entityId>:fields`.

`service_tickets:ticket` · `contact_queues:queue` · `contact_campaigns:campaign` · `bot_intents:intent` · `telephony:voice_flow` · `contact_quality:criterion`

## Spots the suite exposes

| Spot ID | Purpose |
|---|---|
| `conversations.inbox:context-panel` | Third-party context cards beside the thread |
| `conversations.inbox:composer-actions` | Extra composer actions alongside templates / attach |
| `conversations.customer360:tabs` | Additional Customer 360 tabs |
| `contact_queues.wallboard:metrics` | Extra wallboard metric tiles |
| `service_tickets.ticket:detail-sections` | Extra case detail sections |

## Spots the suite consumes

| Host spot | What we inject |
|---|---|
| `menu:sidebar:main` | Service / traffic / analytics groups, feature-gated, `labelKey` only |
| `menu:sidebar:settings` | Suite settings entry |
| `menu:topbar:actions` | Agent availability control + softphone trigger (FR-001, FR-002, FR-097) |
| `crud-form:customers:person:fields` | Identity-match confidence field (FR-026) |
| `data-table:customers:people:columns` | Preferred-channel and open-case columns |
| `admin.page:/backend/customers/[id]:after` | Contact-history panel |

All injected menu items use stable ids (`<module>-<feature>-<action>`) since sidebar customisation and tests depend on them.

## Real-time consumption

```ts
useAppEvent('contact_queues.*', handler, [])   // wallboard
useAppEvent('conversations.*', handler, [])    // inbox list + thread
```

`useEventBridge()` is already mounted once in the app shell — the suite does not remount it. Portal pages use the Portal Event Bridge for `portalBroadcast` events.

Every live surface renders **data age** and degrades explicitly on `contact_queues.queue.degraded` or `telephony.provider.degraded` (FR-044, FR-096, SC-021).

## Interaction requirements

- Composer: Enter sends, Shift+Enter newline (FR-014).
- Every dialog: `Cmd/Ctrl+Enter` submits, `Escape` cancels.
- Never `window.confirm` — use `ConfirmDialog` / `useConfirmDialog`.
- Never raw `fetch` — `apiCall` / `apiCallOrThrow` / `readApiResultOrThrow`.
- Non-`CrudForm` writes go through `useGuardedMutation(...).runMutation(...)` with `retryLastMutation` in the injection context.
- `LoadingMessage` / `ErrorMessage` from `@open-mercato/ui/backend/detail` for loading and error states.
- Empty states name what is missing plus the action that resolves it (edge cases: no open conversations, filter yields nothing).
