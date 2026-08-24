---
name: om-deploy-mercato-connect
description: Deploy an explicitly requested Open Mercato Git branch to the mercato-connect manual-testing server behind Caddy, with validated PostgreSQL and attachment backups, Docker Compose cutover, health checks, and rollback notes. Use for "deploy mercato-connect", "mercato-connect.bespokesoft.pl", or deployments under /srv/open-mercato-connect.
---

# Deploy mercato-connect

Deploy only when the user explicitly authorizes a branch. Treat `/srv/open-mercato-connect` and its persistent Docker volumes as live state. Never copy secrets into the repository or command output.

## Fixed server inventory

- Checkout: `/srv/open-mercato-connect`
- Compose file: `/srv/open-mercato-connect/docker-compose.fullapp.yml`
- Compose project: `open-mercato-connect`
- Public URL: `https://mercato-connect.bespokesoft.pl`
- Caddy upstream: `127.0.0.1:3500`
- App image: `open-mercato/app:connect`
- Containers include `open-mercato-connect-app-1`, `mercato-mcp-connect`, `mercato-opencode-connect`, `mercato-postgres-connect`, Redis, and Meilisearch
- Backup root: `/srv/backups/open-mercato-connect`
- Persistent attachment volume: `mercato-attachments-storage-connect`

Re-discover and verify this inventory before every deployment. Do not assume names stayed unchanged.

## Workflow

### 1. Preflight

1. Resolve the requested remote branch and record its full commit SHA.
2. Record the live checkout branch, commit, status, Compose config, container/image state, volume names, Caddy route, free disk space, and HTTP status.
3. Stop if the checkout has unexpected tracked changes, the target branch cannot be resolved, Caddy targets a different upstream, or disk space is inadequate.
4. Keep the old app container serving while building the replacement image.

Useful read-only checks:

```bash
git -C /srv/open-mercato-connect status --short --branch
git -C /srv/open-mercato-connect fetch origin <branch>
git -C /srv/open-mercato-connect rev-parse FETCH_HEAD
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml ps
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml config
systemctl is-active caddy
curl -sS -o /dev/null -w '%{http_code}\n' https://mercato-connect.bespokesoft.pl/
```

The root URL normally returns `307`; verify the redirect target as well as the status.

### 2. Create and validate a rollback backup

Create a root-only UTC-stamped directory below the backup root. Capture all of the following before switching commits:

- PostgreSQL custom-format dump using `pg_dump -Fc` inside `mercato-postgres-connect`
- compressed tar archive of `mercato-attachments-storage-connect`
- `.env`, Compose file, `/etc/caddy/Caddyfile`, resolved Compose config
- Git HEAD/status, app container inspection, and app image inspection
- SHA-256 manifest covering every backup artifact

Set the directory to mode `0700` and files to `0600`. Validate, do not merely create, the backup:

1. Run `sha256sum -c SHA256SUMS` from the backup directory.
2. List the attachment archive with `tar -tzf`.
3. Copy the database dump temporarily into the Postgres container and run `pg_restore -l` there, then remove the temporary copy.

The host may not have `pg_restore`. Passing a custom dump through `/dev/stdin` can fail with `did not find magic string`; use `docker cp` plus a container-local file for validation.

Record the backup path and pre-deploy commit before continuing.

### 3. Build and cut over

#### Select the minimum safe path from the Git delta

Before changing the checkout, compare the recorded live SHA with the target using `git diff --name-status <live>..<target>`. Classify the complete delta, choosing the most conservative matching path when categories overlap:

- **Identical SHA:** do not rebuild or recreate containers. Re-run health and HTTP verification and report that no cutover was needed.
- **Non-runtime only:** changes confined to documentation, specs, tests, skill metadata, or other files excluded from the production image require no image build. Advance the deployment checkout to the target and verify the unchanged runtime. Do not run Yarn, migrations, or ACL sync.
- **Service/configuration only:** for Compose, Caddy, or a non-app service configuration change, validate the resolved configuration and recreate or reload only the affected service. Build the app only if its Docker build context, build arguments, image contents, or runtime configuration changed.
- **Runtime application:** any app/package source, localization, migration, dependency manifest, generator, Dockerfile, or app entrypoint change requires a production app image build, app cutover, migration check, ACL sync, and MCP recreation. This is the default when classification is uncertain.

Record the classification and the files that caused it. Never call a test-only file non-runtime when the same delta also contains runtime files.

For a direct, persistent-workspace deployment (not the current production Compose builder), choose Yarn work by dependency rather than habit:

- Run `yarn install --immutable` when the lockfile, root/workspace manifests, Yarn configuration, or install state changed.
- Run the first `yarn build:packages` when package source or generator dependencies changed.
- Run `yarn generate` when module discovery inputs, generator code/configuration, module registries, migrations, ACL/setup discovery, or app module files changed.
- Run the second `yarn build:packages` whenever generation ran or generated package inputs changed.
- Run `yarn build:app` for every runtime application change that can affect the Next.js bundle.
- Run `yarn db:migrate` on every app cutover; run ACL sync after readiness. These are correctness gates, not build optimizations.

Do not apply selective host-workspace commands to the current production image. Its fresh Docker builder must contain every package `dist` and generated artifact, so `docker compose ... build app` remains the safe runtime path and its Docker/Yarn/Turbo caches decide internal cache hits. A selective package build is allowed only after the image build itself has an explicit, validated mechanism to seed unchanged artifacts.

For an existing database, preserve this order when deploying directly or when auditing the equivalent Docker build/startup stages:

```bash
yarn install --immutable
yarn build:packages
yarn generate
yarn build:packages
yarn build:app
yarn db:migrate
yarn mercato auth sync-role-acls
# Optional when explicitly needed:
yarn seed:defaults
yarn start
```

The second `yarn build:packages` is intentional: generation writes discovered artifacts that packages must then rebuild. `yarn seed:defaults` is optional and must not be treated as a routine redeployment step.

Never run either of these during an existing-database deployment:

- `yarn initialize` — it is for initialization, not an existing database.
- `yarn db:generate` — it creates migration files; it does not apply migrations.

The production Compose image performs the install and build stages during `docker compose build app`; the app entrypoint applies migrations before `yarn start`. After the app becomes ready, run `yarn mercato auth sync-role-acls` in the app container. Confirm the Dockerfile and Compose entrypoint still cover the ordered steps rather than assuming they do.

```bash
git -C /srv/open-mercato-connect checkout -B deploy/mercato-connect FETCH_HEAD
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml build app
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml up -d --no-deps app
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml exec app yarn mercato auth sync-role-acls
```

The app startup performs guarded initialization/migrations before starting Next.js. Follow its logs until startup completes; do not treat a running container alone as success.

The MCP service shares the app image/build artifacts. After the app is healthy, recreate MCP from the new image:

```bash
docker compose -f /srv/open-mercato-connect/docker-compose.fullapp.yml up -d --no-deps --force-recreate mcp
```

Recreate other services only when their configuration or image actually changed. Caddy does not need a reload when the upstream remains `127.0.0.1:3500`.

### 4. Verify

Verify all of these before reporting success:

- live checkout equals the requested target SHA and remains clean
- app and MCP containers are running without restart loops
- app logs show successful initialization/migrations and server readiness, with no fatal error after readiness
- local upstream and public HTTPS return the expected redirect or success status
- TLS hostname and Caddy routing still work
- a representative backend route loads through the public hostname
- database, Redis, and Meilisearch containers remain healthy/running

Report the target SHA, backup path, changed/recreated services, observed HTTP statuses, and any warnings.

## Rollback

Prefer application rollback first: check out the recorded pre-deploy SHA, rebuild the app image, recreate app, wait for readiness, then force-recreate MCP. If the new migration is not backward-compatible, stop application writers before restoring the validated PostgreSQL dump. Restore attachments only when deployment activity changed them. Never restore a database or volume without explicit user authorization and an additional pre-restore snapshot.

## Learning updates

After each deployment, update this skill only with durable, verified facts. Keep branch names, commit SHAs, timestamps, credentials, and incident-specific details out of the skill.
