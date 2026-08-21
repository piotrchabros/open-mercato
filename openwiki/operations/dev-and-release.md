# Dev & Release Operations

## Development Commands

### Core Dev Workflow

```bash
yarn dev              # Compact dev runtime; press `d` for raw logs
yarn dev:verbose      # Verbose logging
yarn dev:app          # App-only mode (skip package watching)
yarn dev:greenfield   # Full reset: install, build, seed, start
yarn dev:reset        # Clear .mercato/next/dev + legacy .next caches (stale chunks)
```

### Package Watching

The watcher tracks workspace packages for live rebuilds. Memory footprint scales with tracked packages:

```bash
yarn dev --watch=auto-optimized   # Watch only packages you've touched recently
yarn dev --watch=popular           # Watch most frequently changed packages (cap: 6)
OM_WATCH_SCOPE=env OM_WATCH_PACKAGES=core,ui yarn dev  # Explicit set
yarn dev --watch=all               # Watch everything (default)
```

### Database

```bash
yarn db:generate      # Generate migrations from entity schema diff
yarn db:migrate       # Apply migrations (ask first in PRs)
yarn db:greenfield    # Drop + recreate + migrate + seed
yarn initialize       # Full project initialization
yarn seed:defaults    # Seed default data
```

### Code Quality

```bash
yarn lint             # Lint all packages
yarn lint:ds          # Design-system specific lint (token compliance)
yarn typecheck        # TypeScript type checking
yarn agents:check-budget  # Verify AGENTS.md files fit agent instruction budget
yarn i18n:check       # Full i18n validation suite
yarn logger:check-console  # Advisory: find raw console.* calls
```

### Multi-Instance Dev

Run multiple persistent local instances against the same PostgreSQL server:

```bash
yarn dev:greenfield --database-name=my_db      # Explicit name
yarn dev --database-name                        # Derive from CWD
yarn dev --database-name=review_1720 --no-update-env  # One-off, no .env mutation
```

## Docker Setup

### Base Infrastructure (`docker-compose.yml`)

| Service | Image | Purpose |
|---------|-------|---------|
| `opencode` | `opencode-mvp` (built from `./docker/opencode`) | AI assistant container, port 4096 |
| `postgres` | `pgvector/pgvector:pg17-trixie` | PostgreSQL 17 with pgvector extension |
| `redis` | `redis:7-alpine` | Redis 7, maxmemory 512MB |
| `meilisearch` | `getmeili/meilisearch:v1.11` | Fulltext search |
| `localstack` | `localstack/localstack:latest` | S3 emulation (profile: storage-s3) |
| `verdaccio` | `verdaccio/verdaccio:6` | Local npm registry, port 4873 |

### Full App Deployment (`docker-compose.fullapp.yml`)

Full containerized application with `opencode` + `mcp` + postgres + redis + meilisearch. `CACHE_STRATEGY: redis`, `JWT_SECRET` required (no default — fails if missing). Separate network `mercato-network-fullapp`.

### Docker Dev Commands

```bash
yarn docker:up            # Start full app containers
yarn docker:dev:up        # Start dev-mode full app containers
yarn docker:dev           # Run dev inside containers
yarn docker:build:packages  # Build packages in containers
yarn docker:test          # Run tests in containers
```

When a compose `app` container is running, use `node scripts/docker-exec.mjs <cmd>` instead of `yarn <cmd>`.

## CI/CD Pipeline

**Source:** `.github/workflows/ci.yml`

### CI (ci.yml)

- **Triggers:** push + PR on `main`, `develop`, `feat/wms`
- **Runner:** Blacksmith 4vCPU Ubuntu
- **Concurrency:** cancel in-progress on same branch
- **Prepare job:** builds all packages, runs code generator, rebuilds, builds Next.js app, uploads build artifacts
- **Integration shards:** up to 15 parallel runners for full suite, single runner for affected-only
- **Caching:** Yarn packages, node_modules, Turbo build outputs

### Additional Workflows

| Workflow | Purpose |
|----------|---------|
| `mutation-tests.yml` | Mutation testing |
| `audit.yml` | npm audit CI gate with allowlist |
| `qa-deploy.yml` | QA environment deployment |
| `dev-deploy.yml` | Dev environment deployment |
| `snapshot.yml` | Canary snapshot publishing |
| `npm-snapshot-preview.yml` | npm snapshot preview |
| `release-prepare.yml` | Stage 1: version bump + PR |
| `release.yml` | Stage 2: tag + publish + GitHub Release |
| `skills-tiers-lint.yml` | Skill tier validation |
| `openwiki-update.yml` | Scheduled OpenWiki documentation refresh |

## Release Process

**Sources:** `CONTRIBUTING.md`, `.github/workflows/release.yml`, `.github/workflows/release-prepare.yml`

### Branch Model

- `main` — release-ready, every commit tagged/deployable
- `develop` — nightly builds, upcoming release work
- Topic branches: `feat/<name>`, `fix/`, `chore/`, `docs/`

### Two Release Channels

1. **Snapshots** — automatic on every push to `develop`, published under `develop` npm dist-tag
2. **Stable releases** — maintainer-driven, two-stage:
   - **Stage 0:** Add `# <version> (YYYY-MM-DD)` to `CHANGELOG.md`, merge to `main`
   - **Stage 1 (Release Prepare):** `gh workflow run release-prepare.yml --ref main -f bump=patch` — bumps all package versions, pushes `release/v<version>` branch, opens PR
   - **Stage 2 (Release):** `gh workflow run release.yml --ref main` — requires `production` environment approval. Ordered: version resolve → alignment check → "not on npm yet" guard → changelog extraction → build → tag → publish → GitHub Release
   - **Resume:** Both stages accept `resume: true` for partially-failed releases

### Release Scripts

```bash
./scripts/release-patch.sh    # Patch release
./scripts/release-minor.sh    # Minor release
./scripts/release-major.sh    # Major release
./scripts/release-snapshot.sh # Canary snapshot
./scripts/bump-version.sh     # Manifest version bumping
```

### npm Provenance

Release uses GitHub-hosted Ubuntu runners (not Blacksmith) for npm provenance. `id-token: write` permission required. Workflow includes cache-poisoning protection tests (`scripts/__tests__/workflow-cache-poisoning.test.mjs`).

## Validation Commands Checklist

For any change, run the smallest relevant set:

```bash
yarn generate         # Run module generators after adding/modifying module files
yarn build:packages   # Build all packages
yarn typecheck        # TypeScript check
yarn lint             # Lint
yarn test             # Unit tests
yarn build:app        # Build Next.js app
```

The full CI-mirroring gate (used by review/automation skills) is the ordered `validation.commands` list in `.ai/agentic.config.json`:

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
| `yarn agents:check-budget` | Verify AGENTS.md files fit agent instruction budget |

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

## Key Source References

| Area | Source Path |
|------|------------|
| Root package.json scripts | `package.json` |
| Turbo config | `turbo.json` |
| Jest config | `jest.config.cjs`, `jest.config.base.cjs` |
| CI workflow | `.github/workflows/ci.yml` |
| Release workflow | `.github/workflows/release.yml` |
| Release prepare | `.github/workflows/release-prepare.yml` |
| Contributing guide | `CONTRIBUTING.md` |
| Upgrade notes | `UPGRADE_NOTES.md` |
| Docker base | `docker-compose.yml` |
| Docker full app | `docker-compose.fullapp.yml` |
| Agent config | `.ai/agentic.config.json` |
| Dev script | `scripts/dev.mjs` |
| Operational scripts | `scripts/` |
