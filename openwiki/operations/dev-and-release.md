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

## Testing Strategy

### Unit Tests

**Source:** `jest.config.cjs`, `jest.config.base.cjs`

- `testEnvironment: 'node'`, `watchman: false`
- Module name mappers for `@open-mercato/*` packages → `packages/*/src/`
- Custom `jest-mikroorm-transformer.cjs` with `jsx: 'react-jsx'`
- `testMatch`: `**/__tests__/**/*.test.(ts|tsx)` (colocated)
- `setupFiles`: `jest.setup.ts`, `setupFilesAfterEnv`: `jest.dom.setup.ts`
- Memory-bounded: `maxWorkers: 2` per package, `workerIdleMemoryLimit: '512MB'`

```bash
yarn test              # Run unit tests (concurrency 2, 1024MB heap)
yarn test:create-app  # create-app specific tests
```

### Integration Tests

- `__integration__/` directories with `TC-*.spec.ts` naming (e.g., `TC-CHKT-001.spec.ts`, `TC-SEARCH-003.spec.ts`)
- `tests/helpers/renderWithProviders.tsx` — wraps components with `QueryClientProvider` + `I18nProvider`
- Integration tests MUST be self-contained: create fixtures in setup, clean up in teardown
- Integration test coverage is scoped per CI run based on changed files

### QA System

**Source:** `.ai/qa/AGENTS.md` (22KB), `.ai/qa/scenarios/`

130+ QA scenario markdown files covering: admin, auth, catalog, CRM, sales, WMS, Docker, messages, UMES, undo/redo, security (TOTP/passkeys/sudo), email channels, staff timesheets.

### PR QA Gate

A PR carrying `needs-qa` MUST NOT merge unless it also carries `qa-approved`. `skip-qa` is the explicit opt-out (only when no UI-rendering files changed, no DB/API contract changes, and automated tests cover the behavior).

## CI/CD Pipeline

**Source:** `.github/workflows/ci.yml`

### CI (ci.yml — "CI for Develop & Main")

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
`yarn build:packages` → `yarn generate` → `yarn typecheck` → `yarn test` → `yarn build:app`

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
