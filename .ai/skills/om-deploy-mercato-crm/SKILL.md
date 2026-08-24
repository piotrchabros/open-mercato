---
name: om-deploy-mercato-crm
description: Deploy the Open Mercato `crm` branch to the production CRM stack behind Caddy, with validated PostgreSQL and attachment backups, preservation of local custom-domain Compose wiring, Docker Compose cutover, ACL synchronization, health checks, and rollback notes. Use for "deploy crm", "crm.bespokesoft.pl", or deployments under /srv/open-mercato.
---

# Deploy Open Mercato CRM

Deploy only when the user explicitly authorizes the `crm` branch. Treat `/srv/open-mercato`, its database, attachments, and multi-domain routing as production state. Never copy secrets into the repository or command output.

## Fixed server inventory

- Authorized branch: `crm`
- Checkout: `/srv/open-mercato`
- Compose file: `/srv/open-mercato/docker-compose.fullapp.yml`
- Compose project: `open-mercato`
- Canonical URL: `https://crm.bespokesoft.pl`
- Additional Caddy entry points include `crm.bluebee.marketing`, `admin.bespokesoft.pl`, `admin.bluebee.marketing`, `admin.staffinit.com`, and `crm.staffinit.com`
- Caddy upstream: `127.0.0.1:3200`
- App image: `open-mercato/app:prod`
- Containers: `open-mercato-app-1`, `mercato-mcp-prod`, `mercato-opencode-prod`, `mercato-postgres-prod`, `mercato-redis-prod`, and `mercato-meilisearch-prod`
- Backup root: `/srv/backups/open-mercato`
- Persistent attachment volume: `mercato-attachments-storage-prod`

Re-discover and verify this inventory before every deployment. Do not infer CRM settings from the Connect or manufacturing stacks.

## Workflow

### 1. Preflight and local override preservation

1. Fetch `origin/crm`, record its full target SHA, and confirm the requested branch is exactly `crm`.
2. Record the checkout branch, HEAD, status, diff summary, untracked files, resolved Compose config, container/image state, volumes, free disk space, Caddy routes, and HTTP status of the canonical and admin hosts.
3. The checkout may contain intentional local Compose wiring for `BACKEND_CUSTOM_DOMAINS_ENABLED` and `TRUSTED_PROXY_CIDRS`, plus a local pre-change Compose backup. Capture the full diff and these files in the rollback backup.
4. Stop if any local change is unexplained. Do not reset, clean, overwrite, or silently discard local deployment configuration.
5. Before advancing the branch, check whether the target already contains the local custom-domain wiring. If it does, retire the override only after confirming the resolved container environment remains equivalent. If it does not, preserve and reapply the override deliberately.
6. Keep the old app serving while building the replacement image.

Useful read-only checks:

```bash
git -C /srv/open-mercato status --short --branch
git -C /srv/open-mercato fetch origin crm
git -C /srv/open-mercato rev-parse FETCH_HEAD
git -C /srv/open-mercato diff -- docker-compose.fullapp.yml
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml ps
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml config
systemctl is-active caddy
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://crm.bespokesoft.pl/
```

The root URL normally returns `307` to `/start`. Validate the target of every observed redirect.

### 2. Create and validate a rollback backup

Create a root-only UTC-stamped directory below `/srv/backups/open-mercato`. Capture:

- PostgreSQL custom-format dump using `pg_dump -Fc` inside `mercato-postgres-prod`
- compressed tar archive of `mercato-attachments-storage-prod`
- `.env`, live Compose file, any local Compose backup, `/etc/caddy/Caddyfile`, and resolved Compose config
- Git HEAD, status, diff, untracked-file inventory, app container inspection, and app image inspection
- SHA-256 manifest covering every artifact

Set the directory to mode `0700` and files to `0600`. Validate rather than merely creating it:

1. Run `sha256sum -c SHA256SUMS` from the backup directory.
2. List the attachment archive with `tar -tzf`.
3. Copy the database dump temporarily into `mercato-postgres-prod`, run `pg_restore -l` there, and remove the temporary copy.

The host may not have `pg_restore`. A custom dump passed through `/dev/stdin` can fail with `did not find magic string`; use `docker cp` plus a container-local file.

Record the backup path, pre-deploy commit, local override state, and rollback image before continuing.

### 3. Build and cut over

For an existing database, preserve this direct-deployment order or verify that Docker covers its equivalent stages:

```bash
yarn install --immutable
yarn build:packages
yarn generate
yarn build:packages
yarn build:app
yarn db:migrate
yarn mercato auth sync-role-acls
# Optional only when explicitly requested:
yarn seed:defaults
yarn start
```

The second package build is intentional because generation writes discovered artifacts. Never run either command during this deployment:

- `yarn initialize` — it is not for an existing database.
- `yarn db:generate` — it creates migration files instead of applying migrations.

Advance the live checkout without resetting local deployment configuration. Use a fast-forward-only update when the checkout is clean; otherwise reconcile the backed-up, understood override against `origin/crm` before building. Stop on conflicts.

```bash
git -C /srv/open-mercato merge --ff-only origin/crm
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml build app
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml up -d --no-deps app
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml exec -T app yarn mercato auth sync-role-acls
```

The app entrypoint applies migrations before `yarn start`. Follow logs through migration completion and Next.js readiness. Do not treat a running container alone as success.

After app health and ACL synchronization succeed, recreate MCP from the same image:

```bash
docker compose -f /srv/open-mercato/docker-compose.fullapp.yml up -d --no-deps --force-recreate mcp
```

Recreate other services only when their image or configuration changed. Do not reload Caddy if the upstream remains `127.0.0.1:3200`.

### 4. Verify

Verify all of these before reporting success:

- live HEAD equals the resolved `origin/crm` target and all expected local deployment overrides remain accounted for
- app and MCP use the new identical image and have no restart loop; MCP is healthy
- logs show successful migrations, server readiness, and no fatal error after readiness
- role ACL synchronization completed successfully
- local port 3200 and public HTTPS return expected success or redirect responses with valid TLS
- canonical CRM, secondary CRM, platform admin, and organization-bound hostnames still route correctly
- custom-domain environment wiring is present in the resolved app configuration
- PostgreSQL, Redis, Meilisearch, and OpenCode remain healthy/running

Report the target SHA, backup path, local override disposition, recreated services, HTTP results, and warnings.

## Rollback

Prefer application rollback first: restore the recorded pre-deploy commit and Compose override state, rebuild the app image, recreate app, wait for readiness, synchronize ACLs if required, then recreate MCP. If migrations are not backward-compatible, stop application writers before restoring the validated database dump. Restore attachments only if deployment activity changed them. Never restore a database or volume without explicit user authorization and another pre-restore snapshot.

## Learning updates

After each deployment, update this skill only with durable, verified facts. Keep commit SHAs, timestamps, credentials, raw environment values, and incident-specific details out of it.
