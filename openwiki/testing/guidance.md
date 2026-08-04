---
type: "Reference"
title: "Testing Guidance"
description: "Testing strategy for Open Mercato — Jest unit tests, Playwright integration specs, validation commands, and key test suites by domain."
---

# Testing Guidance

Open Mercato uses a layered testing strategy: unit tests (Jest), integration tests (self-contained spec files), and manual QA gating.

## Test Runner

**Jest** with Turborepo orchestration.

### Configuration

- **Base config:** `jest.config.base.cjs` — shared across all packages
  - `maxWorkers: 2` — caps workers per package so the turbo fan-out stays bounded
  - `workerIdleMemoryLimit: 512MB` — recycles workers that exceed heap, instead of growing toward V8's ceiling
- **Per-package config:** each package has its own `jest.config.cjs` that spreads the base
- **Root config:** `jest.config.cjs` — orchestrates the full suite
- **Setup files:** `jest.setup.ts`, `jest.dom.setup.ts` — shared test setup

### Memory Discipline

From `jest.config.base.cjs` comments: `turbo run test` launches one Jest main per package, and each main forks workers. Left uncapped, worst-case worker count is `(packages × cores)`. The base config pins:
- `maxWorkers: 2` per package
- `workerIdleMemoryLimit: 512MB` per worker

Peak RSS approximation: `(turboConcurrency × maxWorkers) × perWorkerHeapCap + mainOverhead`

The root `test` script sets `NODE_OPTIONS=--max-old-space-size=768` and `--concurrency=2` for turbo.

### Running Tests

```bash
yarn test                              # run all unit tests (turbo, concurrency=2)
yarn workspace @open-mercato/core test  # run tests for a specific package
yarn workspace @open-mercato/search test
yarn workspace @open-mercato/ui test
```

In Docker mode:
```bash
node scripts/docker-exec.mjs test
```

## Test File Conventions

### Unit Tests

- Co-located with source: `__tests__/` directories next to the code under test
- Naming: `*.test.ts` (unit), `*.test.tsx` (React component)
- Examples:
  - `packages/core/src/modules/sales/components/documents/__tests__/AddressesSection.test.tsx`
  - `packages/shared/src/lib/__tests__/string.test.ts`
  - `packages/search/src/vector/lib/__tests__/ollama-url-safety.test.ts`

### Integration Tests

- Naming: `TC-<MODULE>-<NUMBER>.spec.ts` (Test Case spec files)
- Location: `__integration__/` directories within modules
- Self-contained: create required fixtures in test setup, clean up in teardown/finally
- Do not rely on seeded/demo data
- Examples:
  - `packages/core/src/modules/sales/__integration__/TC-SALES-4053-inline-customer-address.spec.ts`
  - `packages/core/src/modules/api_keys/__integration__/TC-APIKEY-007.spec.ts`
  - `packages/core/src/modules/directory/__integration__/TC-DIR-014-stale-selected-org-orphan.spec.ts`

### Test Mocks

- Shared mocks: `packages/core/jest.mocks/`
- Per-module test setup in `jest.setup.ts`

## Key Test Files (by domain)

### Security / Scope Enforcement

| Test | What it verifies |
|------|-----------------|
| `packages/core/src/modules/directory/utils/__tests__/organizationScope.test.ts` | Organization scope resolution |
| `packages/core/src/modules/directory/__integration__/TC-DIR-014-stale-selected-org-orphan.spec.ts` | Stale org selection fails loud (PR #3936) |
| `packages/core/src/modules/attachments/lib/__tests__/reconcileOrganization.test.ts` | Attachment organization reconciliation |
| `packages/core/src/modules/attachments/lib/__tests__/requestScope.test.ts` | Attachment request scope (selected org, not home org) |
| `packages/core/src/modules/api_keys/__integration__/TC-APIKEY-007.spec.ts` | API key scoped deletion fails closed (PR #4051) |
| `packages/ai-assistant/src/modules/ai_assistant/lib/__tests__/scope-injection.test.ts` | Code Mode tenant/org scope enforcement (PR #4174) |
| `packages/core/src/modules/auth/api/__tests__/users.route.test.ts` | User route recipient scoping |

### Sales Business Rules

| Test | What it verifies |
|------|-----------------|
| `packages/core/src/modules/sales/commands/__tests__/documents.line-shipped-guard.test.ts` | Order line qty ≥ shipped quantity (PR #4163) |
| `packages/core/src/modules/sales/__integration__/TC-SALES-4053-inline-customer-address.spec.ts` | Customer address preservation in shipments |
| `packages/core/src/modules/sales/components/documents/__tests__/ShipmentDialog.reRenderLoop.test.tsx` | Shipment dialog re-render loop |
| `packages/core/src/modules/sales/components/__tests__/salesDocumentFormQuickCreate.test.tsx` | Quick create form |

### Optimistic Locking

| Test | What it verifies |
|------|-----------------|
| `optimistic-lock-editable-entities.test.ts` | Editable entities expose `updated_at` |
| `optimistic-lock-ui-coverage.test.ts` | New mutating UI calls send lock header or are allowlisted |

### Search / Embeddings

| Test | What it verifies |
|------|-----------------|
| `packages/search/src/__tests__/embedding.test.ts` | Embedding service |
| `packages/search/src/modules/search/api/embeddings/__tests__/route.ollama-base-url.test.ts` | Ollama base URL safety |
| `packages/search/src/modules/search/lib/__tests__/provider-probe.test.ts` | Provider availability probe |
| `packages/search/src/vector/lib/__tests__/ollama-url-safety.test.ts` | Ollama URL safety |
| `packages/core/src/modules/query_index/__tests__/status-coverage-waterfall.test.ts` | Query index status diagnostics (PR #4015) |

### CRM Interaction Unification & Calendar

| Test | What it verifies |
|------|-----------------|
| `packages/core/src/modules/customers/__integration__/TC-CRM-084-interaction-statuses-dictionary.spec.ts` | `interaction-statuses` dictionary seeds all five default statuses |
| `packages/core/src/modules/customers/__integration__/TC-CRM-085-interaction-status-lifecycle.spec.ts` | Interaction status transitions through planned → in_progress → done |
| `packages/core/src/modules/customers/__integration__/TC-CRM-086-deal-open-activities-enricher.spec.ts` | `in_progress` interaction counts toward deal `openActivitiesCount` |
| `packages/core/src/modules/customers/__integration__/TC-CAL-001.spec.ts`–`TC-CAL-011.spec.ts` | Calendar API range reads, conflict detection, recurrence, preferences |
| `packages/core/src/modules/customers/lib/__tests__/interactionReadModel.test.ts` | Interaction read model hydration (authors, deals, custom fields) |
| `packages/core/src/modules/customers/lib/__tests__/interactionStatus.test.ts` | Open/terminal status semantics helper |

### Module Decoupling

| Test | What it verifies |
|------|-----------------|
| `packages/core/src/__tests__/module-decoupling.test.ts` | Modules don't create hard dependencies on optional modules |

## Validation Commands

Choose the smallest relevant set for your change:

```bash
yarn generate
yarn build:packages
yarn typecheck
yarn lint
yarn lint:ds    # design-system structural rules — run when touching backend admin UI
yarn test
yarn build:app
```

`yarn lint:ds` runs the [`@open-mercato/eslint-plugin-ds`](https://github.com/open-mercato/open-mercato/tree/main/packages/eslint-plugin-ds) rules (via `eslint.ds.config.mjs`) against `packages/core/src/modules`, `packages/enterprise/src/modules`, and `packages/ui/src/backend`. All six rules run at `warn` during rollout. See [architecture/source-map.md](../architecture/source-map.md) for the rule list.

### Full CI-Mirroring Gate

From `.ai/agentic.config.json` — the ordered validation sequence used by review/automation skills:

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

### Runner Selection

If a Docker compose file is running:
```bash
node scripts/docker-exec.mjs test
node scripts/docker-exec.mjs typecheck
node scripts/docker-exec.mjs lint
```

Otherwise, use `yarn <cmd>` on the host.

Record the chosen runner in PR output (e.g., `Runner: docker (docker-compose.fullapp.dev.yml)` or `Runner: local`).

## AI/QA Testing

### Agentic Test Specs

Specs live in `.ai/specs/` with naming `{YYYY-MM-DD}-{title}.md`. Each new feature spec MUST list integration coverage for all affected API paths and key UI paths, and implement the integration tests as part of the same change.

### QA Gate

- `qaGate: true` in `.ai/agentic.config.json`
- PRs with `needs-qa` (without `skip-qa`) require `qa-approved` label before merge
- `skip-qa` for docs-only, dependency-only, CI-only, test-only, or similarly low-risk changes
- Self-QA exception: engineer checks out PR, runs locally, attaches proof, applies `qa-approved` + `qa-self-verified`

### Automation Skills

AI automation skills in `.ai/skills/` handle:
- `om-auto-create-pr` — one-shot auto-PR (default for small fixes)
- `om-auto-review-pr` — automated PR review
- `om-integration-tests` — integration test scaffolding
- `om-smart-test` — intelligent test selection
- `om-auto-qa-scenarios` — QA scenario generation

Install with: `yarn install-skills` (installs into `.agents/skills/`)

## When Adding Tests

1. **Unit tests:** co-locate in `__tests__/` next to source, name `*.test.ts(x)`
2. **Integration tests:** place in `__integration__/`, name `TC-<MODULE>-<NUMBER>.spec.ts`
3. **Self-contained:** create fixtures in setup, clean up in teardown — no dependency on seeded data
4. **Test both queue strategies** for workers: `QUEUE_STRATEGY=local` and `QUEUE_STRATEGY=async`
5. **Test both cache strategies** when relevant: `CACHE_STRATEGY=memory` and production strategy
6. **Run `yarn generate`** before tests if module files were added/modified
