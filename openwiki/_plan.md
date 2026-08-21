# OpenWiki Documentation Plan

## Pages to Create

### 1. /openwiki/quickstart.md
- Project overview, what Open Mercato is
- Tech stack, prerequisites, getting started commands
- Monorepo + standalone app paths
- Wiki navigation (links to all section pages)
- Backlog

### 2. /openwiki/architecture/overview.md
- Module system structure (packages/core/src/modules/<module>/)
- Auto-discovery + code generation (yarn generate)
- DI (Awilix) per-request container
- MikroORM v7 data layer
- Multi-tenancy (tenant + organization)
- Bootstrap pipeline (createBootstrap)
- Evidence: AGENTS.md, packages/shared/src/lib/bootstrap/factory.ts, packages/shared/src/lib/di/container.ts, packages/core/src/modules/customers/ structure

### 3. /openwiki/architecture/module-anatomy.md
- Standard module files: index.ts, acl.ts, setup.ts, di.ts, ce.ts, encryption.ts, events.ts, data/entities.ts, data/validators.ts, api/<resource>/route.ts, commands/
- CRUD route factory (makeCrudRoute)
- Command pattern (audit, undo, transactions)
- OpenAPI generation per module
- Evidence: packages/core/src/modules/customers/, packages/shared/src/lib/crud/factory.ts, packages/core/src/modules/customers/commands/people.ts

### 4. /openwiki/architecture/security-and-tenancy.md
- Two-level tenancy (tenant + organization)
- RBAC: role ACLs + user ACLs, feature model, wildcard grants
- Encryption: AES-256-GCM, KMS, tenant DEKs, encryption maps
- findWithDecryption pattern
- Route-level guards (requireAuth, requireFeatures)
- Optimistic locking
- Evidence: packages/core/src/modules/directory/, packages/core/src/modules/auth/services/rbacService.ts, packages/shared/src/lib/encryption/, packages/shared/src/lib/crud/optimistic-lock.ts

### 5. /openwiki/workflows/key-workflows.md
- Spec-first development process
- AI assistant architecture (typed agents, MCP, Code Mode)
- AI agent harness (evaluation matrix, sandboxed runs)
- Event bus + subscribers (ephemeral/persistent)
- Search indexing (hybrid: fulltext + vector + tokens)
- Checkout payment flow
- Evidence: .ai/specs/, packages/ai-assistant/, packages/create-app/agentic/, packages/events/, packages/search/, packages/checkout/

### 6. /openwiki/operations/dev-and-release.md
- Dev commands, Docker setup, watch modes
- Build pipeline (yarn build, turbo)
- Test strategy (unit + integration TC-*.spec.ts)
- CI/CD pipeline
- Release process (snapshots + stable releases)
- Validation commands checklist
- Evidence: package.json scripts, turbo.json, .github/workflows/, CONTRIBUTING.md, docker-compose.yml, jest.config.cjs

### 7. /openwiki/source-map.md
- Package inventory with purpose for each package
- Key directory map (.ai/, apps/, packages/, scripts/)
- Evidence: /packages/, /apps/, /.ai/
