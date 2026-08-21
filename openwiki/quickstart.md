# Open Mercato — Code Wiki Quickstart

Open Mercato is an open-source **AI-Engineering Foundation Framework** — a modular, multi-tenant CRM/ERP platform built on Next.js App Router, TypeScript, MikroORM, and Awilix DI. It ships with ready-made business modules (CRM, sales, catalog, checkout, WMS), an architecture-aware AI agent harness, and spec-first development workflows.

**Version:** 0.6.7 · **License:** MIT · **Node.js:** 24.x · **Package manager:** Yarn 4

## Tech Stack

- **Runtime:** Node.js 24, Next.js App Router
- **Language:** TypeScript (strict)
- **ORM:** MikroORM v7 + PostgreSQL 17 (pgvector)
- **DI:** Awilix (per-request container)
- **Validation:** Zod
- **Cache:** Redis
- **Search:** Meilisearch (full-text) + pgvector (vector) + token search
- **Queue:** Redis-backed persistent queue
- **Auth:** JWT sessions, bcryptjs hashing, RBAC + user-level ACLs
- **Build:** TurboRepo (32-way concurrency)
- **Test:** Jest (memory-bounded), Stryker (mutation), Playwright (browser)
- **AI:** MCP server, agentic harness (Claude Code, Codex, Cursor)

## Two Ways to Use Open Mercato

### 1. Monorepo (Core Development)

```bash
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato && git checkout develop
docker compose up -d          # PostgreSQL, Redis, Meilisearch
cp apps/mercato/.env.example apps/mercato/.env
# Set DATABASE_URL / JWT_SECRET / REDIS_URL in apps/mercato/.env
yarn dev:greenfield           # install, build, seed, start
```

Open `http://localhost:3000/backend` — credentials are printed in the terminal.

### 2. Standalone App (Build on Top of Open Mercato)

```bash
npx create-mercato-app my-app
cd my-app
docker compose up -d
# Set DATABASE_URL / JWT_SECRET / REDIS_URL in .env
yarn setup                    # install, seed, start
```

## Repository at a Glance

```
open-mercato/
├── apps/
│   ├── mercato/          # Next.js app (entry point, ties all packages together)
│   └── docs/             # Documentation site (Mintlify)
├── packages/
│   ├── core/             # 40 business modules (CRM, sales, catalog, auth, etc.)
│   ├── cli/              # `mercato` CLI + code generators
│   ├── create-app/       # `create-mercato-app` scaffolding + agentic harness
│   ├── shared/           # DI container, CRUD factory, encryption, RBAC, rate limiting
│   ├── ui/               # Design system + UI components
│   ├── checkout/         # Public checkout/payment module
│   ├── search/           # Hybrid search (fulltext + vector + tokens)
│   ├── events/           # Event bus + DOM Event Bridge (SSE)
│   ├── queue/            # Redis-backed job queue
│   ├── webhooks/         # Outbound/inbound webhooks (Standard Webhooks)
│   ├── ai-assistant/     # AI assistant + MCP server
│   └── ...               # 15+ other packages
├── .ai/                  # Specs, skills, harness, agentic config
├── scripts/              # 80+ dev/build/test/release scripts
└── .github/workflows/    # 14 CI workflows
```

## Key Concepts

| Concept | Summary |
|---------|---------|
| **Module system** | Each feature lives under `src/modules/<module>/` with auto-discovered frontend/backend pages, APIs, CLI, i18n, entities. See [Module Anatomy](architecture/module-anatomy.md). |
| **Code generation** | `yarn generate` scans convention files and writes `.mercato/generated/` registries. Never hand-edit generated files. |
| **Multi-tenancy** | Core `directory` module defines `tenants` and `organizations`. Most entities carry `tenant_id` + `organization_id`. |
| **RBAC** | Feature-based: `<module>.<entity>.<action>`. Role ACLs + user ACLs per tenant. Wildcard grants supported. |
| **Encryption** | `TenantDataEncryptionService` (AES-256-GCM, KMS). Use `findWithDecryption` instead of raw `em.find`. |
| **Spec-first dev** | Designs documented in `.ai/specs/` before implementation. 170+ specs. See [Key Workflows](workflows/key-workflows.md). |
| **Agentic harness** | AI tooling shipped via `create-app` — skills, evaluation catalog (231 cases), gate hooks. |
| **Optimistic locking** | Default ON for every CRUD entity. `updated_at` versioning, 409 conflicts, unified conflict bar. |

## Essential Commands

```bash
yarn dev                # start dev server
yarn generate           # regenerate .mercato/generated/ registries
yarn build              # full build (packages → generate → packages → app)
yarn typecheck           # TypeScript check
yarn lint                # ESLint
yarn test                # Jest tests
yarn build:app           # build Next.js app
yarn db:migrate           # apply migrations
yarn db:greenfield        # fresh DB from scratch
yarn initialize           # run module setup (seeds, roles)
yarn i18n:check           # all i18n validation
yarn lint:ds              # design system ESLint
```

## Wiki Navigation

| Page | What It Covers |
|------|----------------|
| [Architecture Overview](architecture/overview.md) | Module system, DI, ORM, RBAC, multi-tenancy, encryption, code generation |
| [Module Anatomy](architecture/module-anatomy.md) | Standard module structure, CRUD routes, commands, EAV, widgets, optimistic locking |
| [Security & Tenancy](architecture/security-and-tenancy.md) | Two-level tenancy, RBAC, encryption, optimistic locking, rate limiting, dashboard scope |
| [Module Inventory](domain/modules.md) | All 40 core modules organized by domain (CRM, Operations, Platform, Integration) |
| [Source Map](source-map.md) | Package-by-package map with key paths and responsibilities |
| [Key Workflows](workflows/key-workflows.md) | Dev cycle, scaffolding, code gen, spec-first dev, agentic harness, events, search, checkout, release |
| [Dev & Release Operations](operations/dev-and-release.md) | Dev/build/test commands, Docker, CI/CD, release process, QA system |
| [Operations Runbook](operations/runbook.md) | Quick command reference, Docker, CI/CD, quality checks, deployment |
| [Testing Guide](testing/guide.md) | Test structure, Jest config, TC naming, mutation testing, validation pipeline |

## Where to Look First

| If you want to... | Start here |
|---------------------|------------|
| Understand the module system | [Architecture Overview](architecture/overview.md) → [Module Anatomy](architecture/module-anatomy.md) |
| Add a new module | [Module Anatomy](architecture/module-anatomy.md) → `customers/AGENTS.md` (reference module) |
| Understand code generation | [Key Workflows](workflows/key-workflows.md) → `packages/cli/src/lib/generators/` |
| Set up AI agents | [Key Workflows](workflows/key-workflows.md) → `.ai/skills/om-create-ai-agent/SKILL.md` |
| Run tests | [Testing Guide](testing/guide.md) |
| Deploy | [Dev & Release Operations](operations/dev-and-release.md) |
| Find a specific package | [Source Map](source-map.md) |
| Check conventions | `/AGENTS.md` (root, 32KB task router) → `/packages/<pkg>/AGENTS.md` |
| Check backward compatibility | `/BACKWARD_COMPATIBILITY.md` |
| Check upgrade notes | `/UPGRADE_NOTES.md` |

## Backlog

| Area | Source anchor | Reason deferred |
|------|---------------|-----------------|
| WMS module deep-dive | `packages/core/src/modules/wms/` | Active development on `feat/wms` branch; not yet stable |
| Enterprise package | `packages/enterprise/` | Commercial/proprietary — external contributions rejected |
| Official modules (external submodule) | `external/official-modules/` | Separate git submodule; not part of core monorepo |
| Manufacturing module | `packages/manufacturing/` | Separate package, not yet documented |
| Channel providers (Gmail, IMAP) | `packages/channel-gmail/`, `packages/channel-imap/` | Niche integration packages; low priority for initial docs |
| Provider gateways (Stripe, S3, Akeneo) | `packages/gateway-stripe/`, `packages/storage-s3/`, `packages/sync-akeneo/` | Covered conceptually under integrations; individual provider docs deferred |
| Design system token system | `.ai/ds-rules.md`, `packages/ui/src/theme/` | Large surface area, deserves its own page in a future update |
| AI agent loop controls & overrides | `packages/ai-assistant/`, `.ai/specs/implemented/` | Complex override system, warrants dedicated page |