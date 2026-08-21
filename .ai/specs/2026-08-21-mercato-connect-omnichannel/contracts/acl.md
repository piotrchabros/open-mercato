# Access Control Contract: Mercato Connect

Features are declared per module in `acl.ts` and mirrored into `setup.ts` `defaultRoleFeatures`. After adding features run `yarn mercato auth sync-role-acls` so existing tenants receive the new grants (`packages/core/AGENTS.md` § ACL Grant Sync).

## Rules

- Naming is `<module>.<action>`. Every backend page and API route is gated by a declarative `requireFeatures` guard in page metadata or route config.
- **Never `requireRoles`** — role names are mutable and spoofable. Feature-based guards with immutable ids only.
- Wildcard grants (`conversations.*`) MUST be evaluated through the shared wildcard-aware helpers (`authorizeFeatures`, `rbacService.userHasAllFeatures`), never by exact string comparison against a raw feature array.
- Policy order: invalid scope and nulled/disabled features deny **before** super-admin or wildcard grants are considered.
- Portal features are customer-role features declared in `setup.ts` and enforced by `requireCustomerAuth` / `requireCustomerFeatures` in `page.meta.ts`.

## Features by module

| Module | Features |
|---|---|
| `conversations` | `conversations.view`, `conversations.reply`, `conversations.assign`, `conversations.transfer`, `conversations.close`, `conversations.identity.view`, `conversations.identity.manage` |
| `service_tickets` | `service_tickets.view`, `service_tickets.create`, `service_tickets.edit`, `service_tickets.delete`, `service_tickets.status.change`, `service_tickets.export` |
| `contact_queues` | `contact_queues.view`, `contact_queues.manage`, `contact_queues.wallboard.view`, `contact_queues.case.pull`, `contact_queues.agent_session.manage` |
| `telephony` | `telephony.view`, `telephony.flows.edit`, `telephony.flows.publish`, `telephony.routing.manage`, `telephony.recording.manage`, `telephony.calls.view` |
| `contact_campaigns` | `contact_campaigns.view`, `contact_campaigns.manage`, `contact_campaigns.run` |
| `bot_intents` | `bot_intents.view`, `bot_intents.manage`, `bot_intents.handoff.manage` |
| `contact_quality` | `contact_quality.view`, `contact_quality.review`, `contact_quality.approve`, `contact_quality.criteria.manage` |
| `contact_analytics` | `contact_analytics.view`, `contact_analytics.export` |

## Default role grants

Declared in each module's `setup.ts`:

| Role | Grants |
|---|---|
| `admin` | `conversations.*`, `service_tickets.*`, `contact_queues.*`, `telephony.*`, `contact_campaigns.*`, `bot_intents.*`, `contact_quality.*`, `contact_analytics.*` |
| `employee` (service agent) | `conversations.view`, `conversations.reply`, `conversations.assign`, `conversations.transfer`, `conversations.close`, `conversations.identity.view`, `service_tickets.view`, `service_tickets.create`, `service_tickets.edit`, `service_tickets.status.change`, `contact_queues.view`, `contact_queues.wallboard.view`, `contact_queues.case.pull`, `contact_queues.agent_session.manage`, `telephony.calls.view` |
| `supervisor` (new role) | everything `employee` has, plus `contact_queues.manage`, `contact_quality.view`, `contact_quality.review`, `contact_quality.approve`, `contact_analytics.view`, `service_tickets.export` |
| `superadmin` | all, including destructive `*.delete` |

The role→capability split follows the spec's *Primary user roles* table: agents work cases, supervisors watch and review, managers tune, operators configure.

Note the deliberate asymmetries: agents get `identity.view` but not `identity.manage` (merging affects customer records across the tenant — FR-026/027 make it reversible, but it stays a supervisor act); and `telephony.calls.view` without `recording.manage`, so an agent can see a call in the thread without changing recording policy.

## Portal customer features

Declared as customer-role features and enforced in `frontend/[orgSlug]/portal/**/page.meta.ts`:

| Feature | Grants |
|---|---|
| `portal.cases.view` | See own cases, status and history (FR-066, FR-068) |
| `portal.cases.respond` | Choose an offered resolution; send a message into the thread (FR-067, FR-070) |
| `portal.selfservice.use` | Return/exchange, invoice download, delivery reschedule (FR-069) |

Portal routes scope every query to the authenticated customer. A customer MUST NOT be able to reach another customer's case by id — covered by an integration test, not by UI omission.

## Enforcement points

| Surface | Mechanism |
|---|---|
| Backend pages | `requireAuth` + `requireFeatures` in `page.meta.ts` |
| Portal pages | `requireCustomerAuth` + `requireCustomerFeatures` in `page.meta.ts`, enforced server-side by the `(frontend)` catch-all via `CustomerRbacService` |
| CRUD routes | `makeCrudRoute` feature config |
| Custom write routes | `runMutationGuards(..., { userFeatures })` before mutating |
| Response enrichers | `features: []` on the enricher — it runs only if the caller holds all listed features |
| Menu items | Feature-gated injection widgets; wildcard-aware filtering |
| AI tools | Tool-pack feature gating in `ai-tools.ts` |
