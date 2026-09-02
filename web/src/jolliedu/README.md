# jolliedu — self-built (non-EE) admin API

A license-compliant, self-hosted admin surface for programmatically managing
organizations, projects, API keys, audit logs, and data deletion — **without an
Enterprise (EE) license**.

Langfuse's packaged admin API (`/api/admin/*`, `/api/public/projects` POST,
etc.) is gated behind the EE `admin-api` entitlement, which requires
`LANGFUSE_EE_LICENSE_KEY`. This module reimplements the same operations over the
**MIT core** primitives, authenticated by a single static bearer token.

## Compliance boundary

Langfuse's license is split by directory (see repo-root `/LICENSE`):

- `ee/`, `web/src/ee/`, `worker/src/ee/` → Enterprise License.
- Everything else (`packages/shared/**`, `web/src/features/**`, Prisma models,
  RBAC) → MIT.

This module lives entirely outside the EE directories and only calls MIT
primitives:

- `prisma.organization.create` / `prisma.project.create` — MIT Prisma models.
- `createAndAddApiKeysToDb` — `@langfuse/shared/src/server/auth/apiKeys` (MIT).
- `prisma.auditLog.findMany/count` — same query shape as the MIT
  `web/src/server/api/routers/auditLogs.ts` (the EE audit-log-viewer is only a
  React table wrapper, not the query).
- `ProjectDeleteQueue`, `traceDeletionProcessor` —
  `@langfuse/shared/src/server` (MIT).

It does **not** copy EE-directory code, and it does **not** bypass the EE
license gate. Authentication is an independent implementation (not the EE
`AdminApiAuthService`).

## Layout

```
web/src/jolliedu/
├── auth.ts                       shared static-token gate (used by all features)
├── http.ts                       shared error responder + pagination inputs
├── admin/                        org / project / apiKey management
│   ├── organizations.ts
│   ├── projects.ts
│   └── apiKeys.ts                mint / list / revoke project keys
├── audit-log/
│   └── auditLogs.ts              read-only audit log listing
└── data-deletion/
    ├── orgDeletion.ts            delete org (all projects must be gone)
    ├── projectDeletion.ts        soft-delete project + enqueue hard-delete
    └── traceDeletion.ts          enqueue trace deletion

web/src/pages/api/jolliedu/       thin Pages Router shims (re-export handlers)
├── admin/organizations/index.ts
├── admin/organizations/[orgId]/projects/index.ts
├── admin/projects/[projectId]/apiKeys/index.ts
├── admin/projects/[projectId]/apiKeys/[apiKeyId]/index.ts
├── audit-log/index.ts
└── data-deletion/
    ├── organizations/[orgId]/index.ts
    └── projects/[projectId]/{index,traces/index}.ts
```

Pages Router requires route files under `pages/api/`, so each URL is a one-line
shim that re-exports its handler from `web/src/jolliedu/*`.

This feature deliberately lives at `web/src/jolliedu/` rather than the usual
`web/src/features/<feature>/` (see `web/AGENTS.md`). Keeping the fork's code in
one top-level directory isolates it from upstream `src/features/**`, which
minimizes rebase conflicts when tracking upstream. The tradeoff: this path is
outside the `src/features/**` structure conventions, so keep the module
self-contained and route new jolliedu code here rather than scattering it.

## Configuration

The API is **disabled unless** `SELF_ADMIN_API_KEY` is set (fail-closed → 503).
It is a server-only env var declared in `web/src/env.mjs`.

**Self-hosted only.** The API is unconditionally blocked (→ 403) whenever
`NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` is set, even if `SELF_ADMIN_API_KEY` is also
present. This static all-powerful admin token is never reachable on Langfuse
Cloud.

```bash
# generate a strong token
openssl rand -hex 32
```

### Local dev

```bash
# put the token in the repo-root .env (web loads ../.env)
echo "SELF_ADMIN_API_KEY=<token>" >> .env
# env is validated at startup — (re)start the processes
pnpm run dev:web      # HTTP endpoints
pnpm run dev:worker   # required for data-deletion queue consumers
```

Env changes require a restart (validated at boot). New route files and handler
edits hot-reload in dev.

### Self-hosted containers (docker-compose)

The default `docker-compose.yml` pulls **prebuilt** official images, which do
**not** contain this code. Use the repo's `docker-compose.build.yml` instead —
it builds `langfuse-web` and `langfuse-worker` from this source tree and injects
`SELF_ADMIN_API_KEY` into the web container.

```bash
# 1. token in the .env next to the compose file (compose substitutes ${VAR})
echo "SELF_ADMIN_API_KEY=$(openssl rand -hex 32)" >> .env

# 2. build from source and start
docker compose -f docker-compose.build.yml up --build -d

# 3. verify the value reached the container
docker compose -f docker-compose.build.yml exec langfuse-web printenv SELF_ADMIN_API_KEY
```

After changing any `jolliedu/*` code, rebuild with the same `--build` command
(production images are static — no hot reload). Changing only the token value
needs a plain `up -d` (recreates the container, no image rebuild).

> A `404` from an endpoint means the running image predates this code (rebuild).
> A `401`/`503` means the code is live.

## Endpoints

All requests send `Authorization: Bearer $SELF_ADMIN_API_KEY`. Base URL below is
`http://localhost:3000`.

| Method | Path                                                             | Purpose                                 |
| ------ | ---------------------------------------------------------------- | --------------------------------------- |
| POST   | `/api/jolliedu/admin/organizations`                              | create org                              |
| GET    | `/api/jolliedu/admin/organizations?page=&limit=`                 | list orgs (paginated)                   |
| POST   | `/api/jolliedu/admin/organizations/{orgId}/projects`             | create project                          |
| GET    | `/api/jolliedu/admin/organizations/{orgId}/projects?page=&limit=`| list projects (paginated)               |
| POST   | `/api/jolliedu/admin/projects/{projectId}/apiKeys`               | mint project key (secret returned once) |
| GET    | `/api/jolliedu/admin/projects/{projectId}/apiKeys`               | list keys (masked)                      |
| DELETE | `/api/jolliedu/admin/projects/{projectId}/apiKeys/{apiKeyId}`    | revoke a project key                    |
| GET    | `/api/jolliedu/audit-log?orgId=&projectId=&page=&limit=`         | list audit logs                         |
| DELETE | `/api/jolliedu/data-deletion/projects/{projectId}?confirm=true`  | delete project (async)                  |
| POST   | `/api/jolliedu/data-deletion/projects/{projectId}/traces`        | delete traces (body `{traceIds:[]}`)    |
| DELETE | `/api/jolliedu/data-deletion/organizations/{orgId}?confirm=true` | delete org (all projects must be gone)  |

## End-to-end flow

```bash
export TOKEN="$SELF_ADMIN_API_KEY"
export BASE="http://localhost:3000"

# 1. create an organization
#    Pass "ownerEmail" to attach an existing user as OWNER so the org shows in
#    their UI; omit it for a headless org (invisible until a member is added).
ORG=$(curl -s "$BASE/api/jolliedu/admin/organizations" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Org","ownerEmail":"you@example.com"}')
ORG_ID=$(echo "$ORG" | jq -r .id)

# 2. create a project in that org
PROJECT=$(curl -s "$BASE/api/jolliedu/admin/organizations/$ORG_ID/projects" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My Project"}')
PROJECT_ID=$(echo "$PROJECT" | jq -r .id)

# 3. mint a project-scoped ingestion key (secret shown ONCE — save it)
KEY=$(curl -s "$BASE/api/jolliedu/admin/projects/$PROJECT_ID/apiKeys" -X POST \
  -H "Authorization: Bearer $TOKEN")
PK=$(echo "$KEY" | jq -r .publicKey)   # pk-lf-...
SK=$(echo "$KEY" | jq -r .secretKey)   # sk-lf-...

# 4. send a trace — routed to this project purely by the key (Basic auth)
curl -s "$BASE/api/public/ingestion" -X POST \
  -u "$PK:$SK" -H "Content-Type: application/json" \
  -d '{"batch":[{"id":"'$(uuidgen)'","type":"trace-create","timestamp":"'$(date -u +%FT%TZ)'","body":{"id":"'$(uuidgen)'","name":"hello"}}]}'

# 5. read audit logs for the project
curl -s "$BASE/api/jolliedu/audit-log?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN"

# 6. delete specific traces (async; worker purges ClickHouse/S3)
curl -s "$BASE/api/jolliedu/data-deletion/projects/$PROJECT_ID/traces" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"traceIds":["<traceId>"]}'

# 7. delete the whole project (async hard-delete; confirm guard required)
curl -s "$BASE/api/jolliedu/data-deletion/projects/$PROJECT_ID?confirm=true" -X DELETE \
  -H "Authorization: Bearer $TOKEN"
```

Traces/events are always scoped to a project **by the API key**, never by a
request-body field. Each project needs its own key pair; org-scoped keys are
rejected by ingestion.

## Notes / known gaps

- **Ingestion is per-project.** A project needs its own `pk`/`sk`; org keys
  cannot ingest.
- **Deletion is async.** Project/trace deletion enqueues jobs; the running
  `langfuse-worker` purges ClickHouse/S3. Responses return `202`.
- **Org visibility needs a member.** A static token has no creator user, so
  orgs are headless (invisible in the UI) unless you pass `ownerEmail` on
  create to attach an existing user as OWNER.
- **Org deletion requires all projects gone first.** `DELETE
/organizations/{orgId}` mirrors the MIT `organization.delete`: it refuses
  (`409`) while any project row exists (including soft-deleted ones still being
  hard-deleted), then deletes the org and relies on Prisma cascade.
- These endpoints have **no RBAC** — a single static token is all-or-nothing.
  Keep `SELF_ADMIN_API_KEY` secret and rotate it if leaked.
- **No rate limiting.** Unlike the public API, these endpoints bypass the
  public-API middleware, so there is no per-caller throttle. Brute-forcing a
  high-entropy token is infeasible, but a *leaked* token has unthrottled blast
  radius (including mass deletion). Keep the token secret, front the service
  with an ingress/WAF rate limit if it is network-reachable, and rotate on any
  suspicion of exposure.
- **Creates and deletes are audited.** Org/project/API-key creation, API-key
  revocation, and org/project/trace deletion write `audit_logs` rows with a
  `JOLLIEDU_ADMIN` actor sentinel; API-key audit records store only masked key
  fields, never the plaintext secret.
- **List endpoints are paginated.** `GET` orgs, projects, and audit logs accept
  `page` (0-indexed) and `limit` (1–100, default 50) and return `totalCount`.
- **Audit-log scope is exclusive.** Pass exactly one of `orgId` (org-level
  events) or `projectId` (project-level events); passing both is a `400`.
- **Trace deletion respects the skip list.** If a project is in
  `LANGFUSE_DELETE_SKIP_PROJECT_IDS`, the endpoint returns `200` with
  `status: "skipped"` and enqueues nothing, instead of a misleading `202`.
