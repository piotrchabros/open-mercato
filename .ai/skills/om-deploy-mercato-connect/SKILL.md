---
name: om-deploy-mercato-connect
description: Deploy an Open Mercato branch (Mercato Connect or any other side instance) as its own isolated Docker stack behind Caddy on a shared host — clone to /srv/open-mercato-<env>, DEPLOY_ENV isolation, loopback-only port, .env secrets, Caddy vhost + TLS, first-boot init, verification, redeploy and teardown. Use when asked to "deploy mercato-connect", "deploy this branch to <domain>", "put the branch on a test/staging URL", "spin up a second/third instance next to CRM", or "add a Caddy vhost for a mercato instance".
---

# Deploy a branch instance of Open Mercato behind Caddy

Stands up one **self-contained stack per branch** on a host that already runs other
instances, reachable at its own HTTPS domain. `docker-compose.fullapp.yml` is fully
parameterised by `DEPLOY_ENV`: container names, volume names, the network, and the
Postgres database all carry that suffix, so a new value = a brand-new instance that
shares nothing with the ones already running.

The worked example throughout is the **Mercato Connect** test instance
(`mercato-connect.bespokesoft.pl` → `127.0.0.1:3500`, `DEPLOY_ENV=connect`,
`/srv/open-mercato-connect`). Substitute env/domain/port for any other branch.

## Preconditions — check all five before touching anything

```bash
dig +short <domain>            # must equal the host's public IP …
curl -s -4 ifconfig.me         # … this one. If not, stop: ACME will fail.
ss -lntp | grep -E ':3[0-9]{3}'   # pick a loopback port nobody listens on
df -h /                        # the image build wants >15 GB headroom
free -h                        # each running stack costs ~1.5–2.5 GB RSS
docker ps --format '{{.Names}}'   # confirm the DEPLOY_ENV suffix is unused
```

**Never reuse an existing `DEPLOY_ENV`.** It is the only isolation key — reusing one
silently attaches the new checkout to the running instance's volumes, database and
containers, and `docker compose up` will recreate *their* containers from *your*
compose file.

## 1. Check out the branch into its own directory

One checkout per instance, under `/srv/open-mercato-<env>`. Cloning from a local
working copy is far faster than GitHub; repoint `origin` afterwards so later
redeploys can `git fetch`:

```bash
git clone --branch <branch> file:///path/to/local/checkout /srv/open-mercato-<env>
git -C /srv/open-mercato-<env> remote set-url origin git@github.com:<owner>/open-mercato.git
git -C /srv/open-mercato-<env> log --oneline -1     # verify the deployed commit
```

A local-path clone only carries **committed** work — uncommitted changes in the source
working copy are not deployed. Commit (or `git stash show`-check) first.

## 2. Write `.env` next to the compose file

The compose file reads `.env` from its own directory. Generate every secret fresh —
never copy `JWT_SECRET` / `TENANT_DATA_ENCRYPTION_KEY` from another instance (shared
signing keys make tokens from one instance valid on the other).

```bash
cd /srv/open-mercato-<env> && umask 077 && ENC_KEY=$(openssl rand -hex 32) && cat > .env <<EOF
DEPLOY_ENV=<env>
APP_PORT=127.0.0.1:<port>       # loopback ONLY — Caddy is the public edge
CONTAINER_PORT=3000

APP_URL=https://<domain>
APP_ALLOWED_ORIGINS=https://<domain>
PLATFORM_PRIMARY_HOST=<domain>
PLATFORM_DOMAINS=<domain>
PLATFORM_PORTAL_BASE_URL=https://<domain>

POSTGRES_USER=mercato
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=open-mercato-<env>

JWT_SECRET=$(openssl rand -hex 32)
MEILISEARCH_MASTER_KEY=$(openssl rand -hex 24)
# Both, same value — the FALLBACK one is what the KMS actually reads (see below)
TENANT_DATA_ENCRYPTION_KEY=$ENC_KEY
TENANT_DATA_ENCRYPTION_FALLBACK_KEY=$ENC_KEY

ADMIN_EMAIL=<admin email>
OM_INIT_SUPERADMIN_EMAIL=<admin email>
OM_INIT_SUPERADMIN_PASSWORD=<generated, report it to the user once>

NODE_OPTIONS=--max-old-space-size=1536
MCP_NODE_OPTIONS=--max-old-space-size=1024
REDIS_MAXMEMORY=256mb
DEMO_MODE=false
SELF_SERVICE_ONBOARDING_ENABLED=false
EOF
chmod 600 .env
```

Rules that bite if ignored:

- `APP_PORT` takes a full bind spec. Bare `3500` publishes on **all interfaces**,
  exposing the app around Caddy; always write `127.0.0.1:<port>`.
- `JWT_SECRET` has no default — compose refuses to start without it (`:?` guard).
- `TENANT_DATA_ENCRYPTION_KEY` is 64 hex chars (`openssl rand -hex 32`) — **but it is
  not the key that gets used.** `resolveDerivedKeySecret()` in
  `packages/shared/src/lib/encryption/kms.ts` reads
  `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` **first**, and the compose file defaults it to
  the published literal `dev-tenant-encryption-fallback-key-32chars`. Leave it unset
  and every tenant record is encrypted under a secret that ships in the repo. Set
  **both** to the same freshly generated value, before first boot:

  ```bash
  KEY=$(openssl rand -hex 32)
  printf 'TENANT_DATA_ENCRYPTION_KEY=%s\nTENANT_DATA_ENCRYPTION_FALLBACK_KEY=%s\n' "$KEY" "$KEY" >> .env
  ```

  Changing it later orphans everything already encrypted (including user e-mails, which
  is how login resolves accounts) — on an existing instance this is a key-rotation
  exercise, not an edit. Confirm which secret is live in the startup banner:
  `Source: TENANT_DATA_ENCRYPTION_FALLBACK_KEY` plus a fingerprint.
- All four `APP_URL` / `APP_ALLOWED_ORIGINS` / `PLATFORM_*` values must be the public
  origin. Leaving `localhost:3000` breaks post-login redirects, generated links and
  the origin allowlist behind the proxy.
- `.env` is `chmod 600` and lives outside the repo tree contents you commit —
  **never commit it, never echo secrets into a PR, an issue or a log.**
- AI provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OM_AI_PROVIDER`,
  `OM_AI_MODEL`) are optional; add them only when the branch's features need AI, and
  tell the user you reused an existing key so the spend is not a surprise.

## 3. Build the image

```bash
cd /srv/open-mercato-<env>
docker compose -f docker-compose.fullapp.yml build app 2>&1 | tail -80
```

Expect **~20 minutes** on a busy shared host (measured: 19 min for the Mercato Connect
instance — full monorepo build via turbo/esbuild plus the Next production build, then
~135 s just to export and unpack the ~6.2 GB image). Run it in the background and
poll — do not let a short tool timeout kill it. `| tail` buffers everything until the
end; write to a log file instead when you want live progress.

The image is tagged `open-mercato/app:<env>`, and the `mcp` service reuses that exact
tag — build `app` only, never both, or the two builds race on one tag.

**Never run `yarn install` / `yarn generate` / `yarn build` on the host.** The
`Dockerfile` already runs `yarn install --immutable` and
`yarn build:packages && yarn generate && yarn build:packages` in the builder stage,
and the runner stage reinstalls with `yarn workspaces focus --production`. The
deployment checkout has no `node_modules` and needs none; a host-side `yarn` only
burns time and can leave state that confuses the next build.

## 4. Bring the stack up

```bash
docker compose -f docker-compose.fullapp.yml up -d
docker compose -f docker-compose.fullapp.yml ps
docker compose -f docker-compose.fullapp.yml logs -f app
```

First boot runs `mercato init` (schema + seed + superadmin from `OM_INIT_SUPERADMIN_*`)
guarded by the `mercato-init-marker-<env>` volume, then `yarn start`; later boots run
migrations only. Init takes several minutes (~5 on this host) — a 502 during that
window is normal. `meilisearch`, `redis` and `postgres` must go healthy before `app`
starts.

`init-or-migrate.sh` captures the whole init run to a temp file and prints it **only
when it finishes**, so `docker logs -f app` sits on a single
`First run: full initialization...` line and looks hung. Probe real progress against
the database instead, and wait on the port rather than the log:

```bash
docker exec mercato-postgres-<env> psql -U <user> -d open-mercato-<env> \
  -c "select count(*) from information_schema.tables where table_schema='public'"
# 0 → still migrating; a full schema is ~300 tables

until curl -sf -o /dev/null --max-time 5 http://127.0.0.1:<port>/login \
  || ! docker ps --format '{{.Names}}' | grep -q '^open-mercato-<env>-app-1$'; do sleep 10; done
```

The second condition matters: without it the loop waits forever on a container that
already crashed. When init finishes, the flushed log ends with a banner listing the
seeded superadmin/admin/employee accounts and their passwords — that is where you
read the credentials to hand back.

Do **not** add `-f docker-compose.fullapp.traefik.yml` behind Caddy — that overlay
starts a second TLS terminator that fights for :80/:443.

## 5. Add the Caddy vhost

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.<name>-$(date +%Y%m%d-%H%M%S)
```

Append a block next to the sibling instances, with a comment naming the containers,
the database and the compose directory — the next person reads the Caddyfile first:

```caddy
<domain> {
	# Open Mercato — branch <branch>, instance <env>.
	# Containers: mercato-*-<env>, DB open-mercato-<env>,
	# compose dir /srv/open-mercato-<env>, loopback 127.0.0.1:<port>.
	reverse_proxy 127.0.0.1:<port>
}
```

`reverse_proxy` preserves the `Host` header, which the app needs for domain-bound
organisation resolution — do not rewrite it.

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Caddy fetches the certificate on the first TLS handshake; the vhost can be added
while the image still builds (visitors get 502 until the app answers), which hides
the ACME latency.

## 6. Verify — a 200 on `/login` is not proof

Work up the stack; each step rules out a different failure:

```bash
# 1. containers: app Up with restarts=0, every dependency healthy
docker compose -f docker-compose.fullapp.yml ps
docker inspect open-mercato-<env>-app-1 --format 'restarts={{.RestartCount}}'

# 2. the app itself, bypassing the proxy
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/login       # 200

# 3. the proxy + certificate  (ssl_verify_result 0 = ACME cert live)
curl -sS -o /dev/null -w '%{http_code} ssl:%{ssl_verify_result}\n' https://<domain>/login
curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://<domain>/
#    the redirect target must be https://<domain>/… — a localhost:3000 target
#    means APP_URL never took effect

# 4. a real login + an authenticated page: proves JWT_SECRET, the DB seed and
#    the encryption key all line up
curl -sS -c /tmp/cj -o /dev/null -X POST https://<domain>/api/auth/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "email=<admin email>" --data-urlencode "password=<password>"
curl -sS -b /tmp/cj -o /dev/null -w 'backend: %{http_code}\n' https://<domain>/backend
rm -f /tmp/cj
```

`/api/auth/login` parses **form-encoded** bodies only. A JSON probe falls through to
`req.formData()`, throws, and comes back `400 {"error":"Invalid credentials"}` — which
reads exactly like wrong credentials. Check the status code: real bad credentials are
**401**, a malformed body is **400**.

Also worth knowing: user e-mails are **encrypted at rest**, so `select email from
users` returns ciphertext — you cannot grep the table to confirm the admin exists.
Log in instead.

Finally, hit one route belonging to the branch you deployed (for Mercato Connect:
`GET /api/communication_channels/channels` → 200) so the report says the feature under
test is actually live, not just that the app boots.

Then report: URL, superadmin e-mail + password, deployed commit, compose directory.

## Redeploy the same instance after new commits

```bash
cd /srv/open-mercato-<env>
git fetch origin && git checkout <branch> && git reset --hard origin/<branch>
docker compose -f docker-compose.fullapp.yml build app
docker compose -f docker-compose.fullapp.yml up -d
# REQUIRED when the branch added ACL features — see below
docker compose -f docker-compose.fullapp.yml exec -T app yarn mercato auth sync-role-acls
```

Data survives (named volumes are keyed by `DEPLOY_ENV`); the init marker makes
`init-or-migrate.sh` skip `mercato init` and run `yarn db:migrate` instead, so new
migrations in the branch apply automatically on boot. You never invoke `db:migrate`
by hand.

**Role ACLs are the one thing no boot step syncs.** A fresh `mercato init` calls
`ensureDefaultRoleAcls`, so a brand-new instance already has every feature the branch
declares. An **existing** database does not: newly declared `defaultRoleFeatures`
never reach roles that already exist, so the branch's pages and menu entries are
simply invisible to admin/employee and it looks like the deploy silently failed. Run
the idempotent sync after every redeploy of a branch that touched `acl.ts` /
`setup.ts` (add `--tenant <id>` only to target one tenant):

```bash
docker compose -f docker-compose.fullapp.yml exec -T app yarn mercato auth sync-role-acls
# ✅ Synced role ACLs for tenant <uuid>  (~0.5 s)
```

## Teardown

```bash
cd /srv/open-mercato-<env>
docker compose -f docker-compose.fullapp.yml down          # keeps data
docker compose -f docker-compose.fullapp.yml down -v       # DESTROYS the DB — ask first
```

Then remove the Caddy block, `caddy validate`, `systemctl reload caddy`, and delete
`/srv/open-mercato-<env>`. Confirm with the user before any `-v` or directory delete.

## Findings worth keeping

- **Isolation is entirely `DEPLOY_ENV`.** Containers (`mercato-*-<env>`), volumes
  (`mercato-postgres-data-<env>`, …), the network (`mercato-network-<env>`) and the DB
  name all derive from it. Nothing else needs renaming for a parallel instance.
- **Ports are the only true collision risk.** Compose publishes `APP_PORT` (and
  `DOCUMENTS_COLLAB_PORT` / `LOCALSTACK_PORT` under their profiles). Postgres, Redis
  and Meilisearch are network-internal and never published — leave it that way.
- **One instance ≈ 6 containers** (app, mcp, opencode, postgres, redis, meilisearch).
  On a shared host cap each instance's heap via `NODE_OPTIONS` / `MCP_NODE_OPTIONS`
  instead of letting V8 grow toward total host RAM.
- **Disk is the silent killer.** The monorepo build cache grows to 100 GB+ across
  instances; check `docker system df` before building and `docker buildx prune
  --filter until=720h` (ask first — it slows every project's next rebuild).
- **Keep every host-level edit reversible**: timestamped Caddyfile backup, `caddy
  validate` before reload, one compose directory per instance, no shared secrets.
- **Sidecars are optional for feature testing.** `mcp` and `opencode` have no compose
  profile and start with the stack; when the branch under test does not touch AI,
  `docker compose -f docker-compose.fullapp.yml up -d app` (deps come along) saves
  ~1 GB and two containers.
- **Ask before touching an instance you did not create.** Prod (`crm`) and other
  branch instances share the Docker daemon and the Caddyfile; a careless
  `docker compose down` in the wrong directory takes them down too.

## The Mercato Connect instance (deployed 2026-08-22)

| | |
|---|---|
| URL | https://mercato-connect.bespokesoft.pl |
| `DEPLOY_ENV` | `connect` |
| Compose dir | `/srv/open-mercato-connect` (`docker-compose.fullapp.yml`) |
| Loopback port | `127.0.0.1:3500` |
| Branch | `fix/pipeline-gate-round-budgets` |
| Database | `open-mercato-connect` in `mercato-postgres-connect` |
| Caddy | vhost block in `/etc/caddy/Caddyfile`, next to `manufacturing.bespokesoft.pl` |
| Credentials | `.env` in the compose dir (mode 600) — never copied anywhere else |

Neighbours on the same host, for port/name collision checks: `open-mercato` (prod,
`crm.bespokesoft.pl`, :3200) and `open-mercato-manufacturing` (:3300).
