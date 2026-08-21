# Source Map

A package-by-package inventory of the Open Mercato monorepo, with the purpose and key entry points for each.

## Apps (`apps/`)

| App | Path | Purpose |
|-----|------|---------|
| **mercato** | `apps/mercato/` | Main Next.js app. User-created modules go in `src/modules/`. Contains `.env.example`, `src/app/` (App Router), `src/instrumentation.ts`, `src/i18n/` locale files |
| **docs** | `apps/docs/` | Documentation site (Fumadocs). Framework docs under `docs/framework/`, deployment guides, API docs |

## Core Packages (`packages/`)

### Platform Foundation

| Package | Path | Purpose |
|---------|------|---------|
| **shared** | `packages/shared/` | Cross-cutting utilities, types, DSL helpers, i18n, data engine, encryption, DI container, CRUD factory, rate limiting, OpenAPI generator, boolean parsing, bootstrap factory |
| **ui** | `packages/ui/` | Design system: ~70 primitives, backend components (CrudForm, DataTable, AppShell, injection system), portal components, AI chat UI, theme system, Figma code-connect |
| **core** | `packages/core/` | Business modules (40+ modules under `src/modules/`), bootstrap, generated entity IDs |
| **cli** | `packages/cli/` | `mercato` CLI: module generators (module-registry, module-di, module-facts, openapi), agentic-init/setup, migration tools |
| **create-app** | `packages/create-app/` | `create-mercato-app` scaffolding, agentic setup wizard, agent harness, standalone skills, template sync |

### Infrastructure

| Package | Path | Purpose |
|---------|------|---------|
| **events** | `packages/events/` | Event bus (ephemeral + persistent subscribers), DOM Event Bridge (PostgreSQL LISTEN/NOTIFY), SSE stream, events worker |
| **queue** | `packages/queue/` | Background workers via job contract. Strategies: local (file-based) and async (BullMQ/Redis). Worker auto-discovery, graceful shutdown |
| **cache** | `packages/cache/` | Tenant-aware caching. Strategies: memory (LRU), Redis, SQLite, JSONFile. Tag-based invalidation |
| **search** | `packages/search/` | Hybrid search: fulltext (Meilisearch), vector (pgvector/Qdrant/ChromaDB), tokens (PostgreSQL). RRF merging, indexing queue |
| **scheduler** | `packages/scheduler/` | Task scheduling |
| **telemetry** | `packages/telemetry/` | Observability and tracing |
| **storage-s3** | `packages/storage-s3/` | S3 storage integration |

### Business Packages

| Package | Path | Purpose |
|---------|------|---------|
| **checkout** | `packages/checkout/` | Payment flow: templates, links, transactions. Event-driven gateway subscribers, rate limiting, email workers |
| **onboarding** | `packages/onboarding/` | Onboarding wizard steps, tenant setup hooks, welcome/invitation emails |
| **content** | `packages/content/` | Static content pages (privacy policies, terms, legal) |
| **manufacturing** | `packages/manufacturing/` | Production management modules |
| **webhooks** | `packages/webhooks/` | Outbound/inbound webhooks, Standard Webhooks signing, delivery queues, admin UI |
| **enterprise** | `packages/enterprise/` | Commercial-only modules and overlays (proprietary, no external PRs) |

### AI

| Package | Path | Purpose |
|---------|------|---------|
| **ai-assistant** | `packages/ai-assistant/` | Typed agent framework (Vercel AI SDK), MCP HTTP server, Code Mode tools, agent/tool registries, mutation approval gate, command palette UI |

### Integrations

| Package | Path | Purpose |
|---------|------|---------|
| **gateway-stripe** | `packages/gateway-stripe/` | Stripe payment gateway adapter |
| **channel-gmail** | `packages/channel-gmail/` | Gmail email channel integration |
| **channel-imap** | `packages/channel-imap/` | IMAP email channel integration |
| **sync-akeneo** | `packages/sync-akeneo/` | Akeneo PIM sync integration |

### Tooling

| Package | Path | Purpose |
|---------|------|---------|
| **eslint-plugin-ds** | `packages/eslint-plugin-ds/` | Design-system ESLint rules (token compliance, no hardcoded colors) |

## Key Directories

### `.ai/` — AI Engineering Infrastructure

| Path | Purpose |
|------|---------|
| `.ai/specs/` | Spec-first development specs (~150+ files, `{YYYY-MM-DD}-{title}.md`) |
| `.ai/specs/implemented/` | Fully implemented specs |
| `.ai/specs/enterprise/` | Commercial edition specs |
| `.ai/skills/` | Local skill registry organized by `tiers.json` (core/design/automation/security/analysis/migration) |
| `.ai/runs/` | Agent session logs (~200 files) |
| `.ai/docs/` | Agent documentation (agent-instructions, module-development, official-modules, pr-workflow, ds-v0-usage-guide) |
| `.ai/qa/` | QA scenarios (130+ markdown files), test cases, email capture data |
| `.ai/lessons.md` | Structured lessons learned from agent sessions |
| `.ai/agentic.config.json` | Root agent configuration (baseBranch, tracker, browser, validation commands, label taxonomy, qaGate) |

### Other Top-Level Directories

| Path | Purpose |
|------|---------|
| `config/` | Configuration files |
| `docker/` | Dockerfiles and container build context |
| `scripts/` | Operational scripts (dev, release, i18n, DS tokens, guards, auditing) |
| `tests/` | Root-level test helpers and shared test infrastructure |
| `certs/` | SSL certificates for local dev |
| `.devcontainer/` | VS Code Dev Container configuration |
| `.vscode/` | VS Code workspace settings |
| `.husky/` | Git hooks (Husky) |
| `.codegraph/` | Code graph data |

## Key Entry Points

| Entry Point | Path | Purpose |
|-------------|------|---------|
| Next.js app | `apps/mercato/src/app/` | App Router pages and API routes |
| CLI binary | `packages/cli/src/bin.ts` | `mercato` CLI entrypoint |
| CLI main | `packages/cli/src/mercato.ts` | CLI command definitions (109KB) |
| create-app | `packages/create-app/src/index.ts` | `create-mercato-app` entrypoint |
| Core bootstrap | `packages/core/src/bootstrap.ts` | Runtime bootstrap (ORM, DI, encryption, cache, events) |
| Shared index | `packages/shared/src/index.ts` | Package barrel exports |
| Module registry (generated) | `apps/mercato/.mercato/generated/modules.bootstrap.generated.ts` | Auto-discovered module wiring |
| Entity IDs (generated) | `packages/core/generated/entities.ids.generated.ts` | Entity ID constants |
| OpenAPI spec (generated) | `apps/mercato/.mercato/generated/openapi.generated.json` | Static OpenAPI assembly |
