# Testing Guide

## Test Structure

Open Mercato uses **Jest** with a two-tier test organization:

| Type | Location | Extension | Purpose |
|------|----------|-----------|---------|
| Unit tests | `packages/<pkg>/src/.../__tests__/` | `*.test.ts` / `*.test.tsx` | Function-level, isolated logic |
| Integration tests | `packages/<pkg>/src/.../__integration__/` | `*.spec.ts` | End-to-end scenario coverage |

Integration tests use a structured **Test Case (TC) naming convention** for traceability to specs.

## Jest Configuration

### Root config (`jest.config.cjs`)

- `testEnvironment: node`
- `testMatch: **/__tests__/**/*.test.(ts|tsx)`
- Custom transform: `scripts/jest-mikroorm-transformer.cjs` with JSX support
- `transformIgnorePatterns: node_modules/(?!(@mikro-orm)/)` — transforms MikroORM source
- Module aliases resolve 20+ package names (`@open-mercato/core`, `@open-mercato/cli`, etc.) to `packages/*/src/`
- `@/` → `apps/mercato/src/`, `@tests/` → `tests/`
- GitHub Actions reporter in CI

### Base config (`jest.config.base.cjs`)

Memory-bounded configuration (addressing issue #2402):

| Setting | Value | Rationale |
|---------|-------|-----------|
| `maxWorkers` | 2 | Caps workers per package so turbo fan-out stays small |
| `workerIdleMemoryLimit` | 512MB | Recycles workers when heap exceeds threshold |

Custom resolver: `scripts/jest-typescript-resolver.cjs` redirects `import ts from 'typescript'` to a JS-based `typescript-js` alias (TypeScript 7 migration workaround).

## Integration Test Case (TC) Naming

Integration spec files follow `{prefix}-{number}.spec.ts`:

| Prefix | Domain | Examples |
|--------|--------|---------|
| `TC-CRM-` | CRM (companies, deals, people, pipeline) | `TC-CRM-001` through `TC-CRM-087+` |
| `TC-CAL-` | Calendar | `TC-CAL-001` through `TC-CAL-012` |
| `TC-AI-` | AI features (agents, injection, mutations) | `TC-AI-AGENT-*`, `TC-AI-INJECT-*`, `TC-AI-MUTATION-*` |
| `TC-UX-` | User experience flows | `TC-UX-001` through `TC-UX-008` |
| `TC-LOCK-OSS-` | Optimistic locking | `TC-LOCK-OSS-001` through `018` |
| `TC-UNDO-` | Undo/redo per entity | Per-entity undo tests |
| `TC-CRM-EMAIL-` | Email integration | `TC-CRM-EMAIL-001` through `007` |
| `TC-INT-` | CLI integration | `TC-INT-008` |
| `TC-WF-` | Workflow integration | `TC-WF-030` |
| `TC-EXAMPLE-` | Example module | `TC-EXAMPLE-016` |
| `TC-SEARCH-` | Search module | `TC-SEARCH-003` |
| `TC-CHKT-` | Checkout | `TC-CHKT-001` through `043` |

TC numbers map to specs in `.ai/specs/`. Some reference issue numbers directly (e.g., `TC-CRM-2453`).

## Unit Test Examples (`customers` module)

| File | Focus |
|------|-------|
| `validators.test.ts` | Field validators |
| `events.broadcast.test.ts` | Event broadcasting |
| `configEntityCommandGuards.test.ts` | Config entity command guards |
| `interactionCommandGuards.test.ts` | Interaction command guards |
| `seedDictionaryScope.test.ts` | Seed dictionary scoping |
| `seedExamplesEncryptionGuard.test.ts` | Seed encryption |
| `ai-agents.test.ts` | AI agent behavior |
| `search.test.ts` | Search functionality |
| `i18n-pl-terminology.test.ts` | Polish i18n terminology |

## Cross-Cutting Tests (`packages/core/src/__tests__/`)

18 test suites covering platform-level concerns:

- `module-decoupling.test.ts` — enforces no direct ORM cross-module relationships
- DI proxy resolution, optimistic lock coverage, feature policy authorization, record locks, cache singletons, hot-path indexes, license metadata, public auth bundle boundary, type dependency classification

## Mutation Testing (Stryker)

Separate from unit/integration tests. Configured in `scripts/stryker/`:

| Script | Purpose |
|--------|---------|
| `scope.mjs` | Determines in-scope files/packages |
| `createConfig.mjs` | Generates Stryker config |
| `report.mjs` | Formats results |
| `enforce.mjs` | Enforces mutation score thresholds |
| `mutation-changed.mjs` | Runs only on changed files |

Has its own CI workflow (`mutation-tests.yml`) — deliberately separate from `ci.yml` so mutation results never get confused with test failures.

## Ephemeral / Integration Test Environments

```bash
yarn mercato test integration     # run integration tests
yarn mercato test ephemeral       # ephemeral environment (testcontainers)
yarn mercato test interactive    # interactive mode
yarn mercato test coverage        # coverage report
yarn mercato test spec-coverage   # spec coverage analysis
```

Ephemeral environments use testcontainers to spin up isolated PostgreSQL + Redis instances per test run.

## Coverage

- `collectCoverageFrom: src/**/*.(ts|tsx)`, excluding `src/modules/**/migrations/**`
- Coverage merging: `scripts/merge-coverage.mjs`

## Test-Related Scripts

| Script | Purpose |
|--------|---------|
| `scripts/audit-ci.mjs` | Dependency audit gate |
| `scripts/repo-wide-guards.mjs` | Repository-wide guard checks |
| `scripts/check-client-boundaries.mjs` | Client/server boundary enforcement |
| `scripts/check-token-parity.mjs` | Design token parity |
| `scripts/check-turbo-task-graph.mjs` | Turbo task graph validation |
| `scripts/test-create-app.ts` | CLI test runner |
| `scripts/test-create-app-integration.ts` | Create-app integration tests |

## AI Agent Testing

The agentic harness includes its own evaluation:

- **231 test cases** in `cases.json` (614KB)
- Deterministic evaluator: `evaluate-agent-harness.mjs`
- Writable oracles (AST, behavior, spec) for trusted verification
- Source link inventory for traceability
- Cross-agent hook parity tests ensure Claude Code, Codex, and Cursor configs stay aligned