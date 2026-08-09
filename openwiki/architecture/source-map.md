---
type: "Reference"
title: "Source Map"
description: "Package-by-package reference for the Open Mercato monorepo — apps, core packages, integration providers, configuration, and AI/agent infrastructure."
---

# Source Map

Package-by-package reference for the Open Mercato monorepo. Use this to find where code lives and which package owns which concern.

## Apps

| App | Path | What it does |
|-----|------|-------------|
| **Mercato** | `apps/mercato/` | Main Next.js App Router application. Contains catch-all route dispatchers (`app/api/[...slug]/route.ts`, `app/(backend)/backend/[...slug]/page.tsx`, `app/(frontend)/[...slug]/page.tsx`), module enablement (`src/modules.ts`), `.env.example`, and `next.config.ts`. User-created modules go in `src/modules/`. App-only modules: `example` (reference module, **disabled by default** — uncomment its `modules.ts` entry to re-enable), `example_customers_sync` (auto-enabled only while `example` is on), `ratelimit_probe` (lightweight rate-limit endpoint probe). |
| **Docs** | `apps/docs/` | Docusaurus documentation site published to docs.openmercato.com. Contains framework guides, installation instructions, and user guides. |

## Core Packages

### `packages/shared/` — `@open-mercato/shared`
Cross-cutting utilities with zero domain dependencies. Import from here for:
- **CRUD factory:** `src/lib/crud/factory.ts` — `makeCrudRoute()`, optimistic lock helpers (`optimistic-lock.ts`, `optimistic-lock-command.ts`), `withAtomicFlush`
- **DI:** `src/lib/di/container.ts` — `createRequestContainer()`, default service registration, `tryResolve` for optional deps
- **i18n:** `src/lib/i18n/` — `useT()` (client), `resolveTranslations()` (server), locale dictionaries
- **RBAC:** `src/lib/auth/featureMatch.ts` — `matchFeature()` wildcard-aware ACL matching
- **Encryption:** `src/lib/encryption/` — `findWithDecryption()`, `findOneWithDecryption()`, GDPR field helpers
- **Events:** `src/modules/events/` — `createModuleEvents()` typed event declaration helper
- **String utilities:** `src/lib/string.ts` — `parseCommaSeparatedList()` (recent refactor, PR #4178)
- **Webhooks:** `src/lib/webhooks/` — Standard Webhooks signing/verification primitives
- **URL safety:** `src/lib/url-safety.ts` — SSRF guards used by workflows and Ollama embeddings
- **Module events:** `src/modules/events/index.ts` — event bus interfaces, subscriber metadata

### `packages/core/` — `@open-mercato/core`
The largest package — 40+ business modules under `src/modules/`. Each module follows the convention described in [architecture/overview.md](overview.md). Key entry points:
- `AGENTS.md` — authoritative module development guide (41KB)
- `src/modules/` — all business modules (see [domain/modules.md](../domain/modules.md) for details)
- `jest.config.cjs`, `jest.setup.ts`, `jest.mocks/` — test infrastructure
- `agentic/` — agentic test/spec tooling

### `packages/ui/` — `@open-mercato/ui`
Backend admin UI and design-system components:
- `src/backend/` — `CrudForm`, `DataTable`, `apiCall`, `RowActions`, `useMessageCompose`, portal hooks
- `src/primitives/` — `Spinner`, buttons, inputs, design-system tokens
- `src/backend/conflicts/` — unified conflict bar for optimistic lock 409s
- `src/backend/fields/registry.generated.ts` — versioned field registry
- `src/ai/records/` — AI record card types and registry
- `AGENTS.md` + `src/backend/AGENTS.md` — UI guidelines

### `packages/ai-assistant/` — `@open-mercato/ai-assistant`
AI chat backend, MCP server, Code Mode tools:
- `src/modules/ai_assistant/lib/` — `codemode-tools.ts`, `scope-injection.ts` (tenant/org scope enforcement)
- MCP HTTP server on port 3001
- `defineAiAgent()`, `defineAiTool()`, `registerMcpTool()` exports
- `AGENTS.md` — comprehensive AI agent/tool authoring guide

### `packages/search/` — `@open-mercato/search`
Three search strategies in one package:
- `src/vector/` — embedding service, `ollama-url-safety.ts`
- `src/modules/search/api/embeddings/` — embedding route with provider probe
- `src/modules/search/lib/provider-probe.ts` — cached fail-closed provider availability check
- `AGENTS.md` — search configuration guide

### `packages/events/` — `@open-mercato/events`
Event bus architecture:
- Local (in-process) and async (Redis-backed via BullMQ) dispatch
- DOM Event Bridge (SSE to browser) — `clientBroadcast: true` events
- Persistent subscribers survive restarts via queue storage
- `QUEUE_STRATEGY=local` → `.mercato/queue/`; `QUEUE_STRATEGY=async` → Redis/BullMQ

### `packages/queue/` — `@open-mercato/queue`
Background job processing:
- Worker contract: `metadata = { queue, id?, concurrency? }`
- Local strategy: file-based queue in `.mercato/queue/`
- BullMQ strategy: Redis-backed with retries
- DB connection budget invariant: `web_pool_max + worker_pool_max ≤ Postgres max_connections`

### `packages/cache/` — `@open-mercato/cache`
Tenant-scoped caching:
- Strategies: memory (default, LRU-bounded), SQLite, Redis
- Tag-based invalidation via `invalidateTag()`
- `CACHE_MEMORY_MAX_ENTRIES` env (default 50000)
- Cache invalidation fires post-commit (after `withAtomicFlush`)

### `packages/scheduler/` — `@open-mercato/scheduler`
Database-managed scheduled jobs with admin UI. A standalone module package (not under `packages/core/`), enabled in `apps/mercato/src/modules.ts` via `{ id: 'scheduler', from: '@open-mercato/scheduler' }`. It depends on `@open-mercato/queue` and `@open-mercato/shared` and follows the standard module conventions (entities, events, acl, di, setup, commands, migrations, integration tests). See [workflows/key-workflows.md](../workflows/key-workflows.md) → Scheduled Jobs for the dual-strategy runtime model.
- `src/modules/scheduler/data/entities.ts` — `ScheduledJob` entity (cron/interval, queue/command targets, scope, next-run tracking)
- `src/modules/scheduler/services/` — `SchedulerService` (register/upsert), `BullMQSchedulerService`, `LocalSchedulerService`
- `src/modules/scheduler/lib/` — `cronParser`, `intervalParser`, `nextRunCalculator`, `activeScheduleLimits`, `scheduledJobSubscriber`, `queueTargetPayload`
- `src/modules/scheduler/commands/jobs.ts` — command-pattern CRUD with undo/redo snapshots and organization scope enforcement

### `packages/eslint-plugin-ds/` — `@open-mercato/eslint-plugin-ds`
Private structural ESLint plugin enforcing the Open Mercato design system. Six rules, all at `warn` during rollout: `require-empty-state`, `require-page-wrapper`, `no-raw-table`, `require-loading-state`, `require-status-badge`, `no-hardcoded-status-colors`. Wired by `eslint.ds.config.mjs` and invoked via `yarn lint:ds` against `packages/core/src/modules`, `packages/enterprise/src/modules`, and `packages/ui/src/backend`. Severity escalates per-rule to `error` once the corresponding design-system health metric allows it.

### `packages/cli/` — `@open-mercato/cli`
Code generators and CLI tooling:
- `yarn generate` → AST-based module discovery → ~20 generated registries
- `yarn db:generate` → MikroORM migration generation
- Module scaffolding, build orchestration
- Binary: `packages/cli/dist/bin.js` (invoked as `yarn mercato`)
- `AGENTS.md` — generator and build guide

### `packages/onboarding/` — `@open-mercato/onboarding`
- Setup wizard steps, `onTenantCreated` / `seedDefaults` hooks
- Welcome/invitation email flows

### `packages/content/` — `@open-mercato/content`
- Static content pages (privacy policies, terms, legal pages)

### `packages/create-app/` — `@open-mercato/create-app`
- Standalone app scaffolding via `npx create-mercato-app`
- Template sync checklist for `apps/mercato/` → create-app mirroring

## Integration Provider Packages

Each provider is a dedicated npm workspace package. Provider modules MUST NOT be added inside `packages/core/src/modules/`.

| Package | Import | Purpose |
|---------|--------|---------|
| `packages/gateway-stripe/` | `@open-mercato/gateway-stripe` | Stripe payment gateway integration |
| `packages/channel-gmail/` | `@open-mercato/channel-gmail` | Gmail email channel integration |
| `packages/channel-imap/` | `@open-mercato/channel-imap` | IMAP email channel integration |
| `packages/storage-s3/` | `@open-mercato/storage-s3` | S3-compatible object storage provider |
| `packages/sync-akeneo/` | `@open-mercato/sync-akeneo` | Akeneo PIM data synchronization |
| `packages/checkout/` | `@open-mercato/checkout` | Checkout flow module |
| `packages/webhooks/` | `@open-mercato/webhooks` | Outbound/inbound webhooks, Standard Webhooks signing, delivery queues |

## Enterprise Package

`packages/enterprise/` — `@open-mercato/enterprise`
- Commercial proprietary software with its own license
- **No external PRs accepted** — see `CONTRIBUTING.md`
- Activated via `OM_ENABLE_ENTERPRISE_MODULES=true` env var
- Includes `record_locks` module (collaborative editing with live presence)
- SSO and security (MFA, passkeys, sudo) via separate env flags

## Configuration & Build Files

| File | Purpose |
|------|---------|
| `package.json` | Root monorepo config — Yarn 4 workspaces, Node 24, all root scripts |
| `turbo.json` | Turborepo task pipeline — build, dev, watch, test, lint, typecheck, generate, db:* |
| `tsconfig.base.json` | Shared TypeScript config |
| `jest.config.base.cjs` | Shared Jest config — maxWorkers: 2, workerIdleMemoryLimit: 512MB |
| `eslint.config.mjs` | Root ESLint config |
| `.yarnrc.yml` | Yarn 4 configuration |
| `.nvmrc` | Node version (24) |
| `docker-compose.yml` | Base dev services (PostgreSQL, Redis, Meilisearch) |
| `docker-compose.fullapp.yml` | Full app Docker deployment |
| `docker-compose.fullapp.dev.yml` | Dev-mode Docker with hot reload |
| `Dockerfile` | Production Docker image |
| `railway.toml` | Railway deployment config |
| `official-modules.json` | Official module activation config (committed) |
| `.ai/agentic.config.json` | Agentic workflow config — base branch, validation commands, labels, QA gate |

## AI/Agent Infrastructure

| Path | Purpose |
|------|---------|
| `.ai/specs/` | Spec-first development specs (`{YYYY-MM-DD}-{title}.md`) |
| `.ai/skills/` | Repo-local AI automation skills (`om-*` pattern) |
| `.ai/docs/module-development.md` | Module scaffolding quick reference |
| `.ai/lessons.md` | Self-improvement lessons log |
| `.ai/review-checklist.md` | PR review checklist |
| `.ai/ds-rules.md` | Design system rules |
| `.ai/agentic.config.json` | Validation commands, pipeline labels, QA gate config |
| `AGENTS.md` (root) | Master agent guide with Task Router table |
| `packages/*/AGENTS.md` | Per-package agent guides |
