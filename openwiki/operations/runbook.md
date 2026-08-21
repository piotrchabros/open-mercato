# Operations Runbook

## Development Commands

| Command | Purpose |
|---------|---------|
| `yarn dev` | Start dev server (Next.js + worker/scheduler supervisors + generate watcher) |
| `yarn dev:greenfield` | Full greenfield: install, build, seed, start |
| `yarn dev:app` | App-only dev mode |
| `yarn dev:ephemeral` | Ephemeral dev environment (testcontainers) |
| `yarn watch:packages` | Watch all packages for changes |
| `yarn generate` | Run code generators |
| `yarn build` | Full build: packages → generate → packages → app |
| `yarn build:packages` | Build all workspace packages |
| `yarn build:app` | Build the Next.js app |
| `yarn typecheck` | TypeScript type-checking |
| `yarn lint` | ESLint across all packages |
| `yarn lint:ds` | Design system ESLint rules |
| `yarn test` | Run test suite (Jest, memory-bounded) |
| `yarn db:generate` | Generate MikroORM migrations |
| `yarn db:migrate` | Apply migrations |
| `yarn db:greenfield` | Greenfield DB setup |
| `yarn initialize` | Initialize tenant + seed defaults |
| `yarn seed:defaults` | Run `seedDefaults` hooks for all modules |
| `yarn start` | Start the built app |
| `yarn mercato` | CLI entry point |

### Validation pipeline (CI-mirroring gate)

Per `.ai/agentic.config.json`, the ordered validation commands for AI agents and CI:

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

Choose the smallest relevant set for a given change. Decide once per gate sequence whether to use Docker mode (when a compose `app` container is running: `node scripts/docker-exec.mjs <cmd>`) or local mode.

## Docker

### Base services

```bash
docker compose up -d   # PostgreSQL 17 (pgvector), Redis, Meilisearch
```

### Full app (multi-service)

```bash
yarn docker:dev:up     # docker-compose.fullapp.dev.yml
yarn docker:up         # docker-compose.fullapp.yml
yarn docker:down       # stop
```

Services: `opencode` (AI assistant), `mcp` (MCP server), `postgres`. Container names are environment-scoped (`mercato-opencode-${DEPLOY_ENV:-local}`). MCP in-network wiring: `http://mcp:3001/mcp`. Shared volume for API keys: `mcp_shared`.

### Dockerfile

Multi-stage build on `node:24-alpine`. Installs `python3 make g++ openssl` for native module compilation. Copies workspace manifests first for Docker layer caching, then all per-package `package.json` files, then source. Next.js telemetry disabled, `NODE_ENV=production`.

## CI/CD

### Main CI (`ci.yml`)

- **Triggers:** push/PR to `main`, `develop`, `feat/wms`
- **Concurrency:** `ci-${{ github.ref }}` with `cancel-in-progress: true`
- **Key env vars:** `OM_OPTIMISTIC_LOCK=all`, `SELF_SERVICE_ONBOARDING_ENABLED=true`
- Uses Blacksmith runners
- CI helpers: `scripts/ci/ds-lint-report.mjs`, `scripts/ci/npm-retry-on-quarantine.sh`

### Release (two-stage)

1. `release-prepare.yml` — version bump PR to `main`
2. `release.yml` — npm publish with provenance (GitHub-hosted runners only, `environment: production`, `id-token: write`)

### Other workflows

| Workflow | Schedule/Trigger | Purpose |
|----------|-------------------|---------|
| `audit.yml` | Daily 06:17 UTC | Dependency vulnerability audit |
| `mutation-tests.yml` | PR to main/develop | Stryker mutation testing |
| `openwiki-update.yml` | Daily 08:00 UTC | Auto-update OpenWiki documentation |
| `snapshot.yml` | — | NPM snapshot publishing |
| `dev-deploy.yml` | — | Dev environment deployment |
| `qa-deploy.yml` / `qa-stop-on-merge.yml` | — | QA environment lifecycle |

## Quality Checks

| Command | Purpose |
|---------|---------|
| `yarn i18n:check` | Full i18n validation: sync, usage, hardcoded, values |
| `yarn i18n:check:fix` | Auto-fix translation sync issues |
| `yarn lint:ds` | Design system ESLint enforcement |
| `yarn ds:tokens:check` | Design token parity check |
| `yarn logger:check-console` | Validate structured logging (no raw `console.*`) |
| `yarn check:dep-versions` | Dependency version consistency |
| `yarn template:sync` | Template sync between monorepo and standalone template |

## Deployment

### Railway

```bash
yarn mercato deploy railway
```

### VPS / production

Multi-service Docker Compose stack (`docker-compose.fullapp.yml`). See [deployment guides](https://docs.openmercato.com/installation/vps).

### Verdaccio (local registry)

```bash
yarn registry:setup-user    # configure local registry
yarn registry:publish       # publish to local registry
```

## Branch Model

| Branch | Purpose |
|--------|---------|
| `main` | Release-ready code, every commit tagged and deployable |
| `develop` | Nightly builds, upcoming release work — **base for feature branches** |
| `feat/<name>` | Feature branches (e.g., `feat/wms`) |

PRs target `develop` unless coordinating a release hotfix. The agentic base branch is `develop` per `.ai/agentic.config.json`.

## Upgrade Notes

`UPGRADE_NOTES.md` documents backward-incompatible changes between framework versions. Companion AI skills for each upgrade window: `.ai/skills/om-auto-upgrade-<from>-<to>/SKILL.md` — mechanically migrates patterns in user codebases. `BACKWARD_COMPATIBILITY.md` (33KB) documents platform contract-surface stability guarantees.

## Key Configuration Files

| File | Purpose |
|------|---------|
| `.ai/agentic.config.json` | Agentic dev config: base branch, tracker, validation commands, labels, QA gate |
| `turbo.json` | TurboRepo task orchestration (32-way concurrency, cache config) |
| `jest.config.cjs` | Root Jest config (module aliases, transform, coverage) |
| `jest.config.base.cjs` | Shared base Jest config (memory-bounded: `maxWorkers: 2`, `workerIdleMemoryLimit: 512MB`) |
| `eslint.config.mjs` | Root ESLint config |
| `eslint.ds.config.mjs` | Design system ESLint config |
| `tsconfig.base.json` | Shared TypeScript config |
| `.nvmrc` | Node version (24) |
| `.yarnrc.yml` | Yarn 4 configuration |
