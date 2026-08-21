# Open Mercato — Code Wiki Quickstart

Open Mercato is an **AI-engineering foundation framework** for building enterprise CRM/ERP applications. It combines a modular, multi-tenant platform with an architecture-aware AI harness that knows where code should go, not just how to write it. The framework ships with ready-made business modules (CRM, Sales, Catalog, Auth, Workflows, Search) so teams start at "80% done."

**Key value propositions:**
- **Architecture-aware AI harness** — agents understand module placement, design-system rules, and spec-first workflows
- **Spec-first development** — all non-trivial changes start with a spec in `.ai/specs/`
- **Modular architecture** — auto-discovered modules with overlay overrides; drop in your own
- **Multi-tenant by default** — strict tenant + organization scoping on every entity and API
- **Open-source, no lock-in** — full code ownership, MIT licensed

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js App Router, TypeScript |
| ORM | MikroORM v7 |
| DI | Awilix (per-request containers) |
| Validation | Zod |
| Database | PostgreSQL 17 (pgvector), Redis 7, Meilisearch |
| Monorepo | Yarn 4 workspaces + Turborepo |
| AI | Vercel AI SDK + MCP + OpenCode (Go) |
| Testing | Jest + Playwright |

**Prerequisites:** Node.js 24, Git, PostgreSQL + Redis (Docker Desktop recommended)

## Getting Started

### Monorepo (core development / full demo)

```bash
corepack enable && corepack prepare yarn@4.12.0 --activate
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato && git checkout develop
docker compose up -d                  # PostgreSQL, Redis, Meilisearch
cp apps/mercato/.env.example apps/mercato/.env
# set DATABASE_URL / JWT_SECRET / REDIS_URL in apps/mercato/.env
yarn dev:greenfield                   # installs, builds, seeds, starts
```

Open **http://localhost:3000/backend** — credentials printed in terminal.

### Standalone app (build on Open Mercato without modifying core)

```bash
npx create-mercato-app my-app
cd my-app
docker compose up -d
# set DATABASE_URL / JWT_SECRET / REDIS_URL in .env
yarn setup                            # installs, seeds, starts
```

## Essential Commands

```bash
yarn dev              # Dev runtime (press `d` for raw logs; variants: :verbose, :app, :greenfield)
yarn build            # Build everything (build:packages / build:app for one side)
yarn generate         # Run module generators (auto-discovery → generated/ files)
yarn lint             # Lint all packages
yarn test             # Unit tests (test:integration for Playwright)
yarn typecheck        # TypeScript type checking
yarn db:generate      # Generate database migrations
yarn db:migrate       # Apply migrations (ask first in PRs)
yarn initialize       # Full project initialization
yarn agents:check-budget  # Verify AGENTS.md files fit agent instruction budget
```

## Monorepo Structure

### Apps (`apps/`)
- **mercato** — Main Next.js app. User-created modules go in `apps/mercato/src/modules/`.
- **docs** — Documentation site (Fumadocs).

### Packages (`packages/`)
All use `@open-mercato/<package>` naming: **shared** (utilities, types, DSL, i18n, data engine), **ui** (design system + backend components), **core** (business modules: auth, catalog, customers, sales, etc.), **cli** (generators, `mercato` CLI), **create-app** (standalone scaffolding + agentic harness), **cache**, **queue**, **events**, **search**, **ai-assistant**, **content**, **onboarding**, **enterprise** (commercial-only), **checkout**, **webhooks**, and integration provider packages (gateway-stripe, channel-gmail, channel-imap, storage-s3, sync-akeneo).

### `.ai/` — AI Engineering Infrastructure
- `.ai/specs/` — Spec-first development (~150+ spec files, named `{YYYY-MM-DD}-{title}.md`)
- `.ai/skills/` — Local skill registry organized by tiers (`tiers.json`)
- `.ai/runs/` — Session logs documenting agent work
- `.ai/docs/` — Agent documentation guides
- `.ai/qa/` — QA scenarios and test cases
- `.ai/agentic.config.json` — Root agent configuration

### `external/official-modules/` (git submodule)
Optional, uncommitted git submodule for community-published modules. When present, it's real working code — first-class for search and refactoring.

## Where to Put Code

| Type | Location |
|------|----------|
| Core platform features | `packages/<package>/src/modules/<module>/` |
| External integration providers | `packages/<provider-package>/` (e.g., `packages/gateway-stripe`) |
| Shared utilities/types | `packages/shared/src/lib/` or `packages/shared/src/modules/` |
| UI components | `packages/ui/src/` |
| User/app-specific modules | `apps/mercato/src/modules/<module>/` |

**Never** add code directly under `apps/mercato/src/` except committed, typed `*.generated.ts` registries.

## Core Principles

- **Spec-first**: Check `.ai/specs/` before coding; enter plan mode for 3+ step tasks
- **No direct ORM relationships between modules** — use foreign key IDs, fetch separately
- **Always filter by `organization_id`** for tenant-scoped entities
- **Use DI (Awilix)** to inject services; avoid `new`-ing directly
- **Validate all inputs with Zod**; derive types via `z.infer`
- **Use `apiCall`** from `@open-mercato/ui/backend/utils/apiCall` — never raw `fetch`
- **Never hard-code user-facing strings** — use locale files (`useT()` / `resolveTranslations()`)
- **No `any` types** — use Zod schemas with `z.infer`, narrow with runtime checks

## Wiki Navigation

- [Architecture Overview](architecture/overview.md) — Module system, auto-discovery, DI, MikroORM, tenancy, bootstrap pipeline
- [Module Anatomy](architecture/module-anatomy.md) — Standard module files, CRUD route factory, command pattern, OpenAPI
- [Security & Tenancy](architecture/security-and-tenancy.md) — RBAC, encryption, optimistic locking, route guards
- [Key Workflows](workflows/key-workflows.md) — Spec-first process, AI assistant, agent harness, event bus, search, checkout
- [Dev & Release Operations](operations/dev-and-release.md) — Dev commands, Docker, testing, CI/CD, release process
- [Source Map](source-map.md) — Package inventory and key directory map

## Backlog

| Area | Source Anchor | Reason |
|------|--------------|--------|
| Design System governance | `.ai/ds-rules.md`, `packages/ui/`, `eslint.ds.config.mjs` | Token compliance, Figma code-connect, and DS-guardian workflow are extensive enough for a dedicated page in a future update |
| Official Modules system | `external/official-modules/`, `.ai/docs/official-modules.md` | Submodule activation, module-id convention, and cross-repo merge order need deeper inspection |
| Enterprise package | `packages/enterprise/` | Commercial-only modules and overlays — scope and licensing boundaries need separate treatment |
| Migration guides | `.ai/skills/om-migrate-mikro-orm/SKILL.md`, `UPGRADE_NOTES.md` | MikroORM v6→v7 migration and version upgrade skills are detailed enough for dedicated docs |
