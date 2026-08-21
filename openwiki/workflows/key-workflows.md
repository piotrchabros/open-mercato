# Key Workflows

## Development Cycle

The standard development loop in the monorepo:

1. **Branch from `develop`** — this is the agentic base branch (per `.ai/agentic.config.json`).
2. **Make changes** — follow module conventions; never edit generated files or add code directly under `apps/mercato/src/` except committed `*.generated.ts` registries.
3. **Run generators** — `yarn generate` after adding or modifying module files that rely on auto-discovery.
4. **Validate** — run the ordered validation pipeline (see [Dev & Release Operations](../operations/dev-and-release.md)).
5. **Spec-first** — for new features, create/update a spec in `.ai/specs/` before coding.
6. **PR to `develop`** — CI runs on push/PR to `main`, `develop`, and `feat/wms`.

### Docker dev mode

When a compose `app` container is running, use `node scripts/docker-exec.mjs <command>` instead of `yarn <command>`:

```bash
yarn docker:dev          # dev server inside container
yarn docker:build:packages
yarn docker:generate
yarn docker:test
```

### Memory-optimized dev

```bash
yarn dev --watch=auto-optimized    # watch only packages you've touched
yarn dev --watch=popular           # watch most frequently changed packages
OM_WATCH_SCOPE=env OM_WATCH_PACKAGES=core,ui yarn dev  # explicit set
```

## Module Scaffolding

New modules follow the `customers` reference module structure. Two paths:

### In-monorepo modules
Copy `packages/core/src/modules/customers/` structure, update module name, run `yarn generate`. Follow `packages/core/AGENTS.md` → "Module Development".

### Standalone app modules
Use the `om-module-scaffold` skill (ships with the agentic harness) to scaffold a module end-to-end: entities, API routes, CRUD commands, UI pages, tests, i18n.

See [Module Anatomy](../architecture/module-anatomy.md) for the full convention file list.

## Code Generation Flow

`yarn generate` calls `runGeneratorSuiteWithStructuralInvalidation()` which runs all generators in dependency order:

1. `module-registry` — scans all convention files, generates import statements + registration arrays
2. `module-entities` — collects MikroORM entity classes
3. `entity-ids` — generates per-entity ID constants
4. `module-di` — generates DI container wiring
5. `module-facts` — extracts static facts (routes, pages, events, features, commands, workers, subscribers, enrichers, guards, interceptors, AI agents)
6. `module-extension-facts` — correlates extensions against host module surfaces
7. `openapi` — emits static OpenAPI JSON spec
8. Other generators (CSS sources, route manifest shards, override targets, etc.)

`yarn generate watch` runs an in-process poller that re-runs generators on file changes. Structural invalidation can trigger re-generation when module structure changes.

## Spec-First Development

Before implementing new features or making significant changes:

1. **Check for a spec** in `.ai/specs/` named `{YYYY-MM-DD}-{title}.md`
2. **Create or update** the spec with your design before implementation
3. **Maintain changelog** — add a dated entry summarizing changes
4. **Update directory** — add new specs to `.ai/specs/README.md`

Specs are referenced by both humans and AI agents. The `.ai/specs/` directory contains 170+ files spanning January–August 2026, covering checkout, CRM, WMS, AI agents, design system, i18n, payments, integrations, optimistic locking, search, workflow engine, and more.

Subdirectories: `analysis/`, `archived/`, `enterprise/`, `implemented/`.

## Agentic Harness

The AI development harness ships as part of `create-mercato-app` and is mirrored by the CLI's `agentic:init` command.

### Setup

- **Standalone apps:** `npx create-mercato-app my-app` — agentic setup runs automatically (unless `--skip-agentic-setup`)
- **Existing apps:** `yarn mercato agentic:init` — wires AI tool harness into an existing app
- Supports: Claude Code, Codex, Cursor (multi-select)

### What it installs

1. **`AGENTS.md`** from template — the root task router document
2. **`.ai/` tree** — skills, harness, lessons, qa, specs, trackers, guides
3. **Module fact-sheets** — `.ai/guides/modules/<id>/` (intersection of bundled allowlist with `src/modules.ts`)
4. **Tool-specific configs** — `.claude/settings.json`, `.codex/`, `.cursor/rules/*.mdc`
5. **External skills** — downloads pinned `open-mercato/skills` archive, hash-verifies, installs core tier (15 skills)
6. **Harness manifest** — SHA-256 hashes all generated files → `.ai/harness/manifest.json`

### Harness evaluation

- **231 test cases** in `cases.json` (614KB)
- Deterministic evaluator: `evaluate-agent-harness.mjs` (237KB)
- Release matrix runner: `run-agent-harness-release.mjs`
- Writable oracles (AST, behavior, spec) for trusted test verification
- Source link inventory for traceability

### Skills tier system

- **Core tier** (default): 15 external skills (auto-create-pr, auto-review-pr, auto-implement-spec, auto-fix-issue, etc.) + 13 local skills
- **Automation tier** (opt-in via `--with automation`): loop engines, issue authoring, upgrade maintenance

### Validation pipeline

Per `.ai/agentic.config.json`, the ordered validation commands:

```bash
yarn build:packages
yarn generate
yarn build:packages
yarn i18n:check-sync
yarn i18n:check-usage
yarn typecheck
yarn test
yarn build:app
```

### Harness gates

Recent commits hardened standalone harness gates — `gate-evidence.ts` hooks enforce validation/typecheck gates before AI agents can commit. Hooks are installed per-tool (Claude Code, Codex, Cursor).

## Release Process

Two-stage release:

1. **Stage 1** (`release-prepare.yml`): Creates a PR with version bump to `main`
2. **Stage 2** (`release.yml`): Publishes the already-committed version

Key principles:
- Only runs from `main` branch
- GitHub-hosted runners only (npm provenance/sigstore requires `github-hosted` runners)
- `environment: production` — requires approval from production environment reviewers
- Every reversible step runs before the irreversible `npm publish --provenance`
- Supports `resume` input to resume partially published releases

Snapshot releases: `scripts/release-snapshot.sh` — publishes preview packages.

## Standalone App Scaffolding

`npx create-mercato-app my-app` pipeline:

1. **Resolve mode:** template scaffolding vs ready-app import (`--app <name>` or `--app-url <github-url>`)
2. **Resolve preset:** `classic` (full demo), `empty` (minimal baseline), `crm` (CRM-focused)
3. **Scaffold:** copy `template/` with placeholder substitution → `applyStarterPreset()` modifies `src/modules.ts`
4. **Agentic setup:** generate shared assets → tool-specific configs → enforce instruction budget → install skills
5. **Git init** (optional)
6. **Print next steps:** `yarn setup` (one-command: .env, install, generate, migrate, initialize, dev)

Ready-app imports download a tarball snapshot, extract as raw source, skip preset selection and agentic setup.