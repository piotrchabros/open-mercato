---
type: "Reference"
title: "Open Mercato — Code Wiki Quickstart"
description: "Entry point for the Open Mercato code wiki — monorepo overview, quick start, essential commands, wiki sections, key conventions, and backlog."
---

# Open Mercato — Code Wiki Quickstart

Open Mercato is an open-source **AI-Engineering Foundation Framework** — a modular, multi-tenant CRM/ERP platform built on Next.js App Router, TypeScript, MikroORM, and Awilix DI. It ships with ready-made business modules (customers, sales, catalog, auth, etc.) and a spec-first, AI-assisted development workflow.

> **External docs:** [docs.openmercato.com](https://docs.openmercato.com/) · **Live demo:** [demo.openmercato.com](https://demo.openmercato.com) · **Agent guide:** [`AGENTS.md`](../AGENTS.md)

---

## What This Wiki Covers

This wiki is a practical map for engineers and AI agents working in this repository. It synthesizes the monorepo structure, architecture, key workflows, domain concepts, operations, testing, and integration points into navigable documentation.

## Monorepo at a Glance

| Area | Path | Purpose |
|------|------|---------|
| **Main app** | `apps/mercato/` | Next.js App Router app — backend admin + frontend. User modules go in `apps/mercato/src/modules/`. |
| **Docs site** | `apps/docs/` | Docusaurus documentation site. |
| **Core modules** | `packages/core/` | 40+ business modules: auth, customers, sales, catalog, directory, entities, attachments, messages, integrations, workflows, dictionaries, etc. |
| **Shared** | `packages/shared/` | Cross-cutting utilities, types, DSL helpers, i18n, CRUD factory, encryption, RBAC feature matching. Zero domain deps. |
| **UI** | `packages/ui/` | Backend admin UI (CrudForm, DataTable, AppShell), design-system primitives, frontend/portal components. |
| **AI Assistant** | `packages/ai-assistant/` | OpenCode agent backend, MCP HTTP server, Code Mode tools, command palette. |
| **Search** | `packages/search/` | Fulltext (Meilisearch), vector (embeddings), token (PostgreSQL) search. |
| **Events** | `packages/events/` | Event bus (ephemeral + persistent), DOM Event Bridge (SSE), cross-process PG LISTEN/NOTIFY. |
| **Queue** | `packages/queue/` | Background job workers (local file-based or BullMQ/Redis). |
| **Cache** | `packages/cache/` | Tenant-scoped cache (memory, SQLite, Redis) with tag-based invalidation. |
| **Scheduler** | `packages/scheduler/` | Database-managed scheduled jobs (cron/interval) with admin UI; BullMQ or local polling strategy. |
| **CLI** | `packages/cli/` | Generators (`yarn generate`), migrations, module scaffolding, build tooling. |
| **DS Lint** | `packages/eslint-plugin-ds/` | Structural ESLint rules enforcing the design system (empty states, page wrappers, raw tables, loading states, status badges, hardcoded status colors). |
| **Integrations** | `packages/gateway-stripe/`, `channel-gmail/`, `channel-imap/`, `storage-s3/`, `sync-akeneo/`, `checkout/`, `webhooks/` | Provider packages for payments, email, storage, PIM sync, and webhooks. |
| **Enterprise** | `packages/enterprise/` | Commercial proprietary modules — **no external PRs accepted**. |
| **Onboarding** | `packages/onboarding/` | Setup wizards, tenant provisioning hooks. |
| **Content** | `packages/content/` | Static content pages (privacy, terms, legal). |
| **Create App** | `packages/create-app/` | Standalone app scaffolding (`npx create-mercato-app`). |

## Quick Start

```bash
# Prerequisites: Node.js 24, Git, Docker Desktop (PostgreSQL + Redis)
corepack enable && corepack prepare yarn@4.12.0 --activate
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato && git checkout develop
docker compose up -d                  # PostgreSQL, Redis, Meilisearch
cp apps/mercato/.env.example apps/mercato/.env
# Set DATABASE_URL / JWT_SECRET / REDIS_URL in apps/mercato/.env
yarn dev:greenfield                   # installs, builds, seeds, starts the app
```

Open **http://localhost:3000/backend** — credentials printed in terminal.

### Essential Commands

| Command | Purpose |
|---------|---------|
| `yarn dev` | Start dev server (monorepo, with package watching) |
| `yarn dev:greenfield` | Full fresh setup: install → build → seed → start |
| `yarn build` | Build all packages + app |
| `yarn generate` | Regenerate auto-discovery registries (run after adding/modifying module files) |
| `yarn test` | Run unit tests (Jest, turbo-fanout, max 2 workers/pkg) |
| `yarn typecheck` | TypeScript type-check all workspaces |
| `yarn lint` | ESLint all workspaces |
| `yarn db:generate` | Generate MikroORM migrations |
| `yarn db:migrate` | Apply migrations |
| `yarn db:greenfield` | Drop + recreate + migrate + seed |
| `yarn i18n:check-sync` | Validate i18n sync across locales |
| `yarn i18n:check-usage` | Detect unused/hardcoded translation keys |
| `yarn install-skills` | Install AI automation skills (`.agents/skills/`) |

### Validation Sequence (CI mirror)

```bash
yarn generate && yarn build:packages && yarn typecheck && yarn lint && yarn test && yarn build:app
```

Runner selection: if Docker compose is running, use `node scripts/docker-exec.mjs <cmd>` instead of `yarn <cmd>`. See [`AGENTS.md`](../AGENTS.md) → Validation Commands.

## Wiki Sections

| Section | Page | What it covers |
|---------|------|----------------|
| **Architecture** | [architecture/overview.md](architecture/overview.md) | Module system, auto-discovery, DI (Awilix), routing, database (MikroORM v7), multi-tenancy, RBAC |
| **Source Map** | [architecture/source-map.md](architecture/source-map.md) | Package-by-package reference, apps, config files, key entrypoints |
| **Key Workflows** | [workflows/key-workflows.md](workflows/key-workflows.md) | CRUD lifecycle, event bus, AI mutations, workflow engine, search indexing, widget injection |
| **Domain Modules** | [domain/modules.md](domain/modules.md) | Sales, customers, catalog, entities, attachments, customer accounts, messages, workflows |
| **Operations** | [operations/runbook.md](operations/runbook.md) | Dev workflow, Docker, DB migrations, env vars, deployment, releases |
| **Testing** | [testing/guidance.md](testing/guidance.md) | Unit vs integration tests, Jest config, validation commands, test conventions |
| **Integrations** | [integrations/overview.md](integrations/overview.md) | AI assistant, search providers, webhooks, provider packages, official modules |

## Key Conventions

- **Spec-first:** Check `.ai/specs/` before implementing. Specs use `{YYYY-MM-DD}-{title}.md` naming.
- **Module conventions:** Each module lives under `src/modules/<module>/` with auto-discovered `api/`, `backend/`, `frontend/`, `subscribers/`, `workers/`, `widgets/`, `data/entities.ts`, `acl.ts`, `events.ts`, `di.ts`, `ce.ts`, `setup.ts`.
- **Module naming:** Plural, snake_case for folders and `id` (e.g., `customer_accounts`). Special cases: `auth`, `core`.
- **Event IDs:** `module.entity.action` — singular entity, past-tense action (e.g., `pos.cart.completed`).
- **Feature naming:** `<module>.<action>` (e.g., `customers.people.view`).
- **Never** edit generated files, add code under `apps/mercato/src/` (except committed `*.generated.ts`), create cross-module ORM relations, or hard-code user-facing strings.
- **Always** run `yarn generate` after adding/modifying module files, enforce tenant/org scoping, use optimistic locking on editable entities, and follow `BACKWARD_COMPATIBILITY.md` for contract changes.
- **i18n:** User-facing strings go through `useT()` (client) or `resolveTranslations()` (server). Run `yarn i18n:check-sync` before PRs.
- **Logging:** Use `createLogger(namespace)` — never raw `console.*`.

## Backlog

| Area | Source anchor | Reason deferred |
|------|--------------|-----------------|
| Enterprise modules | `packages/enterprise/` | Commercial/proprietary — not documented here; see `packages/enterprise/README.md` |
| Data sync module | `packages/core/src/modules/data_sync/` | Partially covered; full data sync workflow deferred |
| Portal module | `packages/core/src/modules/portal/` | Portal extension documented in UI AGENTS.md; not yet synthesized |
| Design system | `.ai/ds-rules.md`, `.ai/ui-components.md` | Large topic; deserves dedicated page in future update |
| Telemetry/OTel | `.ai/specs/2026-04-29-telemetry-and-otel.md` | Spec exists; implementation not inspected |
| POS module | `.ai/specs/SPEC-022-*` | Spec exists; implementation depth not verified |
