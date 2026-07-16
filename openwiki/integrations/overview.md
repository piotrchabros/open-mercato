# Integrations Overview

Open Mercato integrates with external services through dedicated provider packages, an AI assistant layer, a webhook system, and an official modules ecosystem. Each integration is a self-contained npm workspace package.

## AI Assistant

**Package:** `packages/ai-assistant/` — `@open-mercato/ai-assistant`
**AGENTS.md:** Present

Four core components:

1. **OpenCode Agent** — AI backend that processes natural language and executes tools
2. **MCP HTTP Server** — exposes tools to OpenCode via HTTP on port 3001
3. **Code Mode Tools** — 2 meta-tools (`search` + `execute`) where the AI writes JavaScript that runs in a `node:vm` sandbox
4. **Command Palette UI** — Raycast-style frontend interface (Cmd+K / Cmd+L)

### AI Tools and Agents

- **Tools** defined via `defineAiTool()` with Zod schemas, `requiredFeatures`, and `moduleId`
- **Agents** defined via `defineAiAgent()` in each module's `ai-agents.ts`
- Auto-discovered by `yarn generate` → `ai-agents.generated.ts`
- Mutation tools MUST go through `prepareMutation(...)` + approval card — runtime fails closed if bypassed
- `isMutation: true` on write tools — policy gate strips from read-only agents

### Code Mode Scope Injection

`packages/ai-assistant/src/modules/ai_assistant/lib/scope-injection.ts` enforces tenant/org scope on Code Mode `api.request()` calls. Code Mode `api.request()` MUST enforce endpoint-level RBAC before fetch and fail closed for undocumented or featureless mutation endpoints.

### AI Provider Configuration

At least one of:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

Per-module model overrides: `OM_AI_<MODULE>_MODEL` (uppercased module id).

### MCP Server

```bash
yarn mcp:serve    # production MCP server
yarn mcp:dev      # development MCP server
```

### Reference Implementations
- Agents: `packages/core/src/modules/customers/ai-agents.ts`, `packages/core/src/modules/catalog/ai-agents.ts`
- Skills: `.ai/skills/om-create-ai-agent/SKILL.md`

## Search Providers

**Package:** `packages/search/` — `@open-mercato/search`

### Fulltext (Meilisearch)
- Requires `MEILISEARCH_HOST`
- Typo-tolerant search for names, descriptions, titles
- Unavailable if host not configured

### Vector (Embeddings)
- Requires embedding provider: `OPENAI_API_KEY` or Ollama (`OLLAMA_BASE_URL`)
- Semantic/meaning-based search
- pgvector stores vectors (shared instance-level table)
- Ollama checked via `GET {OLLAMA_BASE_URL}/api/tags` — not assumed reachable
- Ollama URL safety enforced: `packages/search/src/vector/lib/ollama-url-safety.ts`
- Provider probe is cached and fail-closed

### Tokens (PostgreSQL)
- Always available — no external service needed
- Baseline keyword search
- Requires `formatResult` in `search.ts` for readable results

### Tenant-Scoped Search Settings
Search settings (Cmd+K strategies, embedding provider/model, auto-index flag) are tenant-scoped. GET/POST via:
```
GET  /api/search/settings/global-search
POST /api/search/settings/global-search
```
GET response carries `source: tenant | instance | env`.

## Webhooks

**Package:** `packages/webhooks/` — `@open-mercato/webhooks`
**AGENTS.md:** Present

### Outbound Webhooks
1. Declare or reuse the source event in the emitting module's `events.ts`
2. Match outbound subscriptions in `subscribers/outbound-dispatch.ts`
3. Create delivery record through `createWebhookDelivery()`
4. Enqueue work through `enqueueWebhookDelivery()` from `lib/queue.ts`
5. Process HTTP delivery only in `workers/webhook-delivery.ts` / `processWebhookDeliveryJob()`
6. Emit lifecycle events (`webhooks.delivery.*`) when delivery state changes

### Inbound Webhooks
1. Implement a provider-local `WebhookEndpointAdapter`
2. Register it with `registerWebhookEndpointAdapter()` from `lib/adapter-registry.ts`
3. Verify signatures inside the adapter, not in the route
4. Return `tenantId` and `organizationId` from the adapter when the provider can resolve them
5. `api/inbound/[endpointId]/route.ts` handles rate limiting, deduplication, and event emission
6. Keep provider-specific business logic in `adapter.processInbound()`

### Signing Standard
Standard Webhooks spec. Shared primitives in `@open-mercato/shared/lib/webhooks`. Secrets are encrypted fields — use `findWithDecryption()` for reads.

## Provider Packages

Each provider is a dedicated npm workspace package. Provider modules MUST NOT be added inside `packages/core/src/modules/`.

### Payment Gateway: Stripe

**Package:** `packages/gateway-stripe/` — `@open-mercato/gateway-stripe`

Stripe payment gateway integration. Integrates with the sales module's payment methods and the integrations module's provider registry.

### Email Channels

**Gmail:** `packages/channel-gmail/` — `@open-mercato/channel-gmail`
- Google Workspace integration (see `.ai/specs/2026-03-29-google-workspace-integration.md`)
- OAuth-based Gmail API integration

**IMAP:** `packages/channel-imap/` — `@open-mercato/channel-imap`
- Standard IMAP email channel
- For providers without dedicated API access

Email channels link to CRM people via `customers.email.linked` / `customers.email.visibility_changed` events.

### Storage: S3

**Package:** `packages/storage-s3/` — `@open-mercato/storage-s3`

S3-compatible object storage provider. Activated via `OM_ENABLE_STORAGE_S3=true`. When enabled, `storage_s3` is added to `enabledModules` in `modules.ts` and the Integration Marketplace exposes the "S3 Object Storage" card.

Can be preconfigured from env vars (see "S3 Storage Preconfiguration" block in `.env.example`).

### PIM Sync: Akeneo

**Package:** `packages/sync-akeneo/` — `@open-mercato/sync-akeneo`

Akeneo PIM (Product Information Management) data synchronization. Integrates with the catalog module and the data_sync infrastructure.

### Checkout

**Package:** `packages/checkout/` — `@open-mercato/checkout`

Checkout flow module. Spec: `.ai/specs/2026-03-19-checkout-simple-checkout.md`.

## Official Modules Ecosystem

Official modules live in a **git submodule** at `external/official-modules/` pointing at `open-mercato/official-modules` (public repo).

### Activation Flow
1. `yarn official-modules add <module-name>` — runs `git submodule add`
2. Postinstall worker (`scripts/official-modules-setup.mjs`) regenerates `apps/mercato/src/official-modules.generated.ts`
3. `apps/mercato/src/modules.ts` spreads official modules into `enabledModules`
4. Run `yarn mercato configs cache structural --all-tenants` after activation changes

### Configuration
- `official-modules.json` (committed) — `activated` is team default, `available` auto-filled when submodule present
- `official-modules.local.json` (gitignored) — personal override

### Module-ID Convention
Package `@open-mercato/<suffix>` ⇒ module id `<suffix>` with dashes converted to underscores (e.g., `@open-mercato/ai-assistant` ⇒ `ai_assistant`).

### Cross-Repo Workflow
Cross-cutting changes (core API + official module): two coordinated PRs — core in open-mercato first → (prerelease) publish → submodule bumps peer dep → submodule PR. No PR is atomic across the two repos.

## Building a New Integration Provider

Use the `om-integration-builder` skill: `.ai/skills/om-integration-builder/SKILL.md`

Key steps:
1. Create a dedicated npm workspace package under `packages/<provider-package>/`
2. Implement the adapter, health check, credentials, and bundle wiring
3. Register with the integrations module (`packages/core/src/modules/integrations/AGENTS.md`)
4. Wire data sync if applicable (`packages/core/src/modules/data_sync/AGENTS.md`)
5. Provider owns its env-backed preconfiguration — implement preset reading/application in the provider module's `setup.ts`
6. Expose a rerunnable provider CLI command when practical
7. Document env variables

## External Skills Collection

AI automation skills are maintained in the shared [open-mercato/skills](https://github.com/open-mercato/skills) collection:

```bash
npx skills add open-mercato/skills --skill '*'
yarn install-skills    # installs into .agents/skills/
```

These skills handle autonomous PR creation, code review, CI stabilization, spec writing, integration testing, and merge management. Repo-specific settings live in `.ai/agentic.config.json`.
