# Open Mercato — Code Wiki Quickstart

Open Mercato is an open-source **AI-Engineering Foundation Framework** — a modular, multi-tenant CRM/ERP platform built on Next.js App Router, TypeScript, MikroORM, and Awilix DI. It ships with ready-made business modules (CRM, sales, catalog, checkout, WMS), an architecture-aware AI agent harness, and spec-first development workflows.

**Version:** 0.6.7 · **License:** MIT · **Node.js:** 24.x · **Package manager:** Yarn 4

## What This Wiki Covers

This wiki documents the monorepo at `/Users/piotrchabros/IdeaProjects/open-mercato`. It is organized into the following sections:

| Section | Page | What's Inside |
|---------|------|---------------|
| **Architecture** | [Architecture Overview](architecture/overview.md) | Monorepo structure, module system, DI, ORM, code generation, bootstrap pipeline |
| **Architecture** | [Module Anatomy](architecture/module-anatomy.md) | Convention file checklist, CRUD route factory, command pattern, cross-module coupling |
| **Architecture** | [Security & Tenancy](architecture/security-and-tenancy.md) | Two-level tenancy, RBAC, encryption, optimistic locking, rate limiting, dashboard scope |
| **Domain** | [Module Inventory](domain/modules.md) | All 40 core modules, their entities, and key domain concepts |
| **Workflows** | [Key Workflows](workflows/key-workflows.md) | Dev cycle, code generation flow, spec-first process, agentic harness, release process, standalone app scaffolding |
| **Operations** | [Dev & Release Operations](operations/dev-and-release.md) | Commands, Docker setup, testing strategy, CI/CD pipeline, release stages, validation checklist |
| **Testing** | [Testing Guide](testing/guide.md) | Jest config, TC naming convention, unit/integration tests, mutation testing, AI agent harness evaluation |
| **Reference** | [Source Map](source-map.md) | Package-by-package inventory with key paths and entry points |

## Key Concepts to Understand First

1. **Module system** — every feature is a self-contained module under `packages/core/src/modules/<module>/` with auto-discovered convention files. The `customers` module is the reference implementation.
2. **Code generation** — `yarn generate` uses ts-morph AST manipulation to produce `.mercato/generated/` files (registries, DI wiring, OpenAPI spec, module fact sheets). Never hand-edit generated files.
3. **Multi-tenancy** — two-level model: `tenants` → `organizations` (with hierarchical trees). Every entity carries `tenant_id` + `organization_id`. Never expose cross-tenant data.
4. **RBAC** — feature-based access control (not role-based). Features are immutable IDs declared in `acl.ts`. Wildcards supported. Two layers: role ACLs + per-user ACL overrides.
5. **CRUD factory** — `makeCrudRoute()` in `packages/shared/src/lib/crud/factory.ts` generates complete HTTP route handlers from declarative config. Handles filtering, pagination, cache, optimistic locking, mutation guards, side effects.
6. **Command pattern** — domain writes go through undoable commands (not direct ORM mutation). Commands provide audit logging, undo/redo, transaction safety via `withAtomicFlush`.
7. **AI harness** — 231-case evaluation matrix testing AI coding agents against real framework contracts. Ships with `create-mercato-app` and `mercato agentic:init`.

## Getting Started for Development

### Monorepo (core development)

```bash
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato && git checkout develop
docker compose up -d          # PostgreSQL, Redis, Meilisearch
cp apps/mercato/.env.example apps/mercato/.env
# Set DATABASE_URL / JWT_SECRET / REDIS_URL in apps/mercato/.env
yarn dev:greenfield           # install, build, seed, start
```

Open `http://localhost:3000/backend` — credentials are printed in the terminal.

### Standalone app (build on top of Open Mercato)

```bash
npx create-mercato-app my-app
cd my-app
docker compose up -d
# Set DATABASE_URL / JWT_SECRET / REDIS_URL in .env
yarn setup                    # install, seed, start
```

### Essential commands

```bash
yarn dev                      # Dev server (press `d` for raw logs)
yarn generate                 # Run module code generators
yarn build:packages           # Build all packages
yarn typecheck                # TypeScript check
yarn lint                     # Lint all packages
yarn test                     # Unit tests (concurrency 2)
yarn db:generate              # Generate migrations from entity diff
yarn db:migrate               # Apply migrations (ask first in PRs)
```

### Validation pipeline (CI-mirroring gate)

Per `.ai/agentic.config.json`:

```
yarn build:packages → yarn generate → yarn typecheck → yarn test → yarn build:app
```

## Architecture at a Glance

- **Stack:** Next.js App Router, TypeScript, zod, Awilix DI, MikroORM v7 (PostgreSQL 17 + pgvector), Redis, Meilisearch
- **Monorepo:** Yarn 4 workspaces + TurboRepo (32-way concurrency). 2 apps + 20+ packages.
- **40 core modules:** customers, sales, catalog, auth, directory, workflows, staff, dashboards, WMS, and more
- **AI infrastructure:** Agent harness, MCP tools, Code Mode sandbox, 25 standalone skills, spec-first development
- **Infrastructure packages:** events (bus + SSE bridge), queue (BullMQ workers), cache (4 strategies), search (hybrid fulltext + vector + token)

## Agent Guidelines

The repository's `AGENTS.md` is the authoritative task router for AI agents — it defines boundary labels (`Always`, `Ask First`, `Never`), validation commands, and a task routing table mapping work types to package-level `AGENTS.md` files. Read it before making any non-trivial changes.

Key rules:
- Never edit generated files, never add code directly under `apps/mercato/src/` (except committed `*.generated.ts`)
- Never create direct ORM relationships between modules
- Never expose cross-tenant data or skip tenant/organization scoping
- Never bypass mutation guards, encryption helpers, or RBAC checks
- Always run `yarn generate` after adding/modifying module files
- Always follow `BACKWARD_COMPATIBILITY.md` before touching contract surfaces

## Backlog

| Area | Source Anchor | Reason Deferred |
|------|---------------|-----------------|
| Official modules submodule | `external/official-modules/`, `.ai/docs/official-modules.md` | Optional submodule, not present in all checkouts |
| Enterprise package | `packages/enterprise/` | Commercial/proprietary, separate licensing concerns |
| Manufacturing module | `packages/manufacturing/` | Actively developed, not yet stable enough for detailed docs |
| Design system token system | `.ai/ds-rules.md`, `packages/ui/src/theme/` | Large surface area, deserves its own page in a future update |
| AI agent loop controls & overrides | `packages/ai-assistant/`, `.ai/specs/implemented/` | Complex override system, warrants dedicated page |
| Webhooks signing & delivery | `packages/webhooks/` | Standard Webhooks spec is external; implementation is straightforward |
| EUDR compliance module | `packages/core/src/modules/eudr/` | Niche regulatory feature, limited applicability |
