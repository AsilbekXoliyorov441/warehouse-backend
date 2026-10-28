# StockPulse — Backend

Real-time, multi-branch inventory management API. Branch staff record receipts, sales,
adjustments and inter-branch transfers; every committed stock change is pushed to authorised
clients over Socket.IO.

Built with **NestJS 11 · TypeScript (strict) · PostgreSQL · Prisma 6 · Socket.IO 4 · Jest**.

The emphasis is on correctness under concurrency rather than feature count:

- Stock can never go negative, even with simultaneous sales (conditional SQL updates + CHECK constraints).
- Retried requests never apply twice (database-enforced idempotency keys).
- Every quantity change has an append-only ledger entry and an audit record in the same transaction.
- Real-time events are written to a **transactional outbox**, so clients only ever see committed changes.
- Socket clients are authorised with exactly the same rules as REST requests.

---

## Contents

1. [Architecture](#architecture)
2. [Getting started](#getting-started)
3. [Configuration](#configuration)
4. [Authentication flow](#authentication-flow)
5. [Roles and permissions](#roles-and-permissions)
6. [REST API reference](#rest-api-reference)
7. [Socket.IO contract](#socketio-contract)
8. [Consistency model](#consistency-model)
9. [Error format and codes](#error-format-and-codes)
10. [Testing](#testing)
11. [Example: concurrent sales](#example-concurrent-sales)
12. [Known MVP limitations](#known-mvp-limitations)
13. [Deployment guidance](#deployment-guidance)

---

## Architecture

```mermaid
flowchart LR
  subgraph Client
    UI[Browser / app]
  end
  subgraph API["NestJS process"]
    direction TB
    MW[Request-ID · Helmet · CORS · ValidationPipe]
    G[JwtAuthGuard → PermissionsGuard]
    C[Controllers]
    S[Services<br/>Inventory · Transfers · Products …]
    L[StockLedgerService<br/>the only writer of quantities]
    I[IdempotencyService]
    P[EventPublisher<br/>(outbox)]
    D[OutboxDispatcher]
    GW[InventoryGateway<br/>namespace /inventory]
    BA[BranchAccessService<br/>single authz source]
  end
  DB[(PostgreSQL)]

  UI -- "REST + Bearer JWT" --> MW --> G --> C --> S
  S --> I
  S --> L --> P
  S & L & I & P -- "one transaction" --> DB
  G & GW --> BA --> DB
  DB -- "committed outbox rows" --> D --> GW
  GW -- "Socket.IO events (branch:/user: rooms)" --> UI
```

```text
src/
  auth/                 login, register, refresh rotation, JWT issuing/verification
  users/                admin user management
  branches/             branch CRUD
  branch-memberships/   memberships + BranchAccessService (authorization rules)
  categories/ products/ catalog
  inventory/            receipts, sales, adjustments, reversals, snapshots, low-stock rule
  stock-movements/      StockLedgerService (atomic stock mutations) + read-only ledger API
  transfers/            PENDING → COMPLETED | CANCELLED workflow
  dashboard/            branch KPIs, low stock, recent movements, stock value
  notifications/        per-user notifications (low-stock alerts)
  audit-logs/           audit trail (secrets are stripped)
  idempotency/          exactly-once command handling
  realtime/             gateway, Socket.IO adapter, event contracts, outbox publisher + dispatcher
  prisma/               PrismaService (transactions with deadlock retry, commit hooks)
  common/               guards, decorators, filters, pipes, DTOs, error codes, permissions
examples/               reference client cache + runnable Socket.IO client
test/                   integration, concurrency and Socket.IO suites (real PostgreSQL)
```

**Layering rules.** Controllers only translate HTTP ↔ service calls. Business rules live in
services. Gateway handlers contain no business logic; they authenticate, authorise and join rooms.
Services never emit socket events directly; they stage them through the `EventPublisher` interface
inside their transaction.

---

## Getting started

### Prerequisites

- Node.js 20.11+ (developed on 22/24 LTS), npm 10+
- Docker with Compose v2 (for PostgreSQL, or the full stack)

### Option A — run the API locally, PostgreSQL in Docker

```bash
npm install
cp .env.example .env                      # then set real secrets (see below)
docker compose up -d db                   # PostgreSQL 17; also creates stockpulse_test
npx prisma migrate deploy                 # apply migrations
npm run db:seed                           # development sample data (refuses in production)
npm run start:dev                         # http://localhost:3000/api
```

> npm 11+ blocks dependency install scripts by default. This repo's `package.json` allow-lists the
> ones needed (`prisma`, `@prisma/engines`, `@prisma/client`, `argon2`). If Prisma complains the
> client is not generated, run `npx prisma generate`.

### Option B — everything in Docker

```bash
docker compose up -d --build              # db + api (migrations run on api start)
docker compose exec api npm run db:seed:compiled
```

### Useful URLs

| What | URL |
| --- | --- |
| API base | `http://localhost:3000/api` |
| Swagger UI | `http://localhost:3000/api/docs` |
| OpenAPI JSON / YAML | `http://localhost:3000/api/docs-json` · `/api/docs-yaml` |
| Health | `http://localhost:3000/api/health` |
| Socket.IO | `ws://localhost:3000/inventory` (namespace `/inventory`) |

### Sample credentials (development seed only)

| Email | Password | Memberships |
| --- | --- | --- |
| `admin@stockpulse.dev` | `Admin12345!` | ADMIN @ Downtown Store, ADMIN @ Airport Kiosk |
| `manager.downtown@stockpulse.dev` | `Manager12345!` | MANAGER @ Downtown Store |
| `manager.airport@stockpulse.dev` | `Manager12345!` | MANAGER @ Airport Kiosk |
| `warehouse@stockpulse.dev` | `Warehouse12345!` | WAREHOUSE_WORKER @ Downtown Store |
| `seller@stockpulse.dev` | `Seller12345!` | SELLER @ Downtown Store, SELLER @ Airport Kiosk |

The seed adds 4 categories and 12 products, with opening stock in both branches recorded as `IN`
movements (several Airport items start below minimum). It is idempotent and exits with an error when
`NODE_ENV=production`.

### Migrations

```bash
npx prisma migrate dev --name <change>    # create a migration in development
npx prisma migrate deploy                 # apply in CI / production (never `db push`)
```

The initial migration adds CHECK constraints Prisma cannot express (`inventory.quantity >= 0`,
positive movement quantities, non-negative prices, distinct transfer branches) as a final safety net.

---

## Configuration

All variables are validated at startup; the process exits with a readable message if any are
missing or invalid. See [`.env.example`](.env.example).

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `development` \| `test` \| `production` |
| `PORT` | | `3000` | |
| `DATABASE_URL` | ✔ | | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | ✔ | | ≥ 32 chars, HS256 signing key |
| `JWT_ACCESS_TTL` | | `15m` | `900s`, `15m`, `1h` |
| `REFRESH_TOKEN_SECRET` | ✔ | | ≥ 32 chars, HMAC key for refresh-token hashes |
| `REFRESH_TOKEN_TTL_DAYS` | | `7` | |
| `FRONTEND_ORIGIN` | ✔ | | Comma-separated allowlist (CORS, Socket.IO, CSRF check), or `*` for any website (public practice API) |
| `COOKIE_SECURE` | | `false` | **Must be `true` in production** (enforced) |
| `COOKIE_SAMESITE` | | `strict` | `strict` \| `lax` \| `none` (`none` requires secure) |
| `TRUST_PROXY` | | `0` | Number of proxy hops, so rate limits see real client IPs |
| `ALLOW_REGISTRATION` | | `true` | Public self-registration; new users have no branch access |
| `MANAGERS_CAN_MANAGE_PRODUCTS` | | `false` | Policy switch granting MANAGER catalog write access |
| `AUTH_RATE_LIMIT` / `AUTH_RATE_TTL_SECONDS` | | `10` / `60` | Per-IP limit for login, register, refresh |
| `OUTBOX_POLL_INTERVAL_MS` | | `1000` | Fallback poll; delivery is normally triggered on commit |
| `SWAGGER_ENABLED` | | on, except in production | Serve Swagger UI at `/api/docs` |
| `SEED_DEMO_DATA` | | `false` | `true` lets the sample-data seed run in production (shared demo logins) |

Generate secrets with:
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

---

## Authentication flow

```text
POST /api/auth/login {email,password}
  ← 200 { accessToken, tokenType:"Bearer", expiresIn:900, user }
  ← Set-Cookie: sp_refresh=<id>.<secret>; HttpOnly; SameSite=Strict; Path=/api/auth; [Secure]

GET  /api/...            Authorization: Bearer <accessToken>
POST /api/auth/refresh   (cookie sent automatically)  ← new accessToken + rotated cookie
POST /api/auth/logout    (cookie)                     ← 204, session family revoked, cookie cleared
```

- **Passwords** are hashed with Argon2id (19 MiB, t=2). Emails are trimmed and lower-cased.
  Unknown email and wrong password return the same `INVALID_CREDENTIALS` error, and the response time is equalised.
- **Access tokens** are short-lived HS256 JWTs (`iss`/`aud` checked). The user is re-loaded on every
  request, so deactivation takes effect immediately.
- **Refresh tokens** are opaque `<row-id>.<256-bit secret>`. Only `HMAC-SHA256(secret)` is stored.
  Each refresh revokes the presented token and issues a new one in the same *family*.
- **Reuse detection:** presenting an already-rotated token (or racing two refreshes with one
  token) revokes the whole family and returns `REFRESH_TOKEN_REUSED`. Clients should serialise
  refresh calls (one in flight per tab or session).
- **Rate limiting** (`@nestjs/throttler`) protects login, register and refresh.

### Token transport and CSRF

- The **access token** lives in memory in the client (not `localStorage`) and is sent as a Bearer
  header. Bearer headers are not attached automatically by browsers, so the regular API is not
  CSRF-exposed.
- The **refresh token** is an `HttpOnly` cookie scoped to `/api/auth`, so JavaScript cannot read it
  and it is never sent to other endpoints. `refresh` and `logout` are the only cookie-authenticated
  endpoints. They are protected by `SameSite=Strict` and by an **Origin allowlist check**
  (`CSRF_ORIGIN_REJECTED`), which also rejects `Sec-Fetch-Site: cross-site` requests without an Origin.
- CORS uses an explicit origin allowlist with `credentials: true`, because the browser must send the
  refresh cookie on `/auth/refresh`.
- If the frontend is served from a different *site* (not just a different subdomain), use
  `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true` and rely on the Origin check.

---

## Roles and permissions

Users get a role **per branch** through `BranchMembership`. Every protected request checks the
caller's membership **on the server**, for the branch the request targets (`branchId` in the
query, body or path), or for the branch derived from the stored entity (movement, transfer).
Client-supplied user ids or roles are never trusted. Unknown properties fail validation.

Organisation-wide actions (users, branches, catalog, audit) are granted when the user holds a
qualifying role in **at least one active branch**. In this MVP, ADMIN is effectively an
organisation administrator, but reading or writing a branch's *stock* still requires membership in
that branch. Admins who create a branch automatically become its ADMIN.

| Permission | ADMIN | MANAGER | WAREHOUSE_WORKER | SELLER |
| --- | :-: | :-: | :-: | :-: |
| Manage users, memberships (`USER_MANAGE`) | ✔ | | | |
| Manage branches (`BRANCH_MANAGE`) | ✔ | | | |
| Manage products / categories (`PRODUCT_MANAGE`) | ✔ | policy¹ | | |
| Read audit logs (`AUDIT_READ`) | ✔ | | | |
| Read catalog (`CATALOG_READ`) | ✔ | ✔ | ✔ | ✔ |
| View branch inventory (`INVENTORY_READ`) | ✔ | ✔ | ✔ | ✔ |
| View movement history (`MOVEMENT_READ`) | ✔ | ✔ | ✔ | ✔ |
| Record receipts (`STOCK_RECEIVE`) | ✔ | | ✔ | |
| Record sales (`SALE_CREATE`) | ✔ | | | ✔ |
| Adjust stock (`STOCK_ADJUST`) | ✔ | | | |
| Reverse a movement (`STOCK_REVERSE`) | ✔ | ✔ | | |
| View transfers (`TRANSFER_READ`) | ✔ | ✔ | ✔ | |
| Create transfers from the branch (`TRANSFER_CREATE`) | ✔ | ✔ | ✔ | |
| Complete / cancel transfers (`TRANSFER_APPROVE`) | ✔ | ✔ | | |
| Branch reports / dashboard (`REPORT_READ`) | ✔ | ✔ | | |
| List branch members (`MEMBERS_READ`) | ✔ | ✔ | | |

¹ `MANAGERS_CAN_MANAGE_PRODUCTS=true`.

**Transfer workflow:** `TRANSFER_CREATE` in the **source** branch creates a `PENDING` transfer.
`TRANSFER_APPROVE` in **either** branch completes or cancels it. The creator may also cancel while
they still hold `TRANSFER_CREATE`. Entities in branches you cannot read are reported as `404`
(not `403`), so ids cannot be probed.

The matrix is defined in one place: [`src/common/constants/permissions.ts`](src/common/constants/permissions.ts).

---

## REST API reference

All routes are under `/api`. All routes except auth/health require `Authorization: Bearer <token>`.

**Swagger UI** at `/api/docs` documents every request *and response* schema, every error code per
endpoint (with examples), the required permission and roles (generated from the same decorators the
guards enforce, so they cannot drift), the `Idempotent-Replayed` / `X-Request-Id` headers and the
Socket.IO payload schemas. Logging in through `POST /auth/login` in the UI authorizes all
subsequent "Try it out" calls automatically. Operation ids (`inventorySell`, `transfersComplete`, …)
are stable for client code generation, e.g.
`npx openapi-typescript http://localhost:3000/api/docs-json -o src/api/schema.d.ts`.
The setup lives in [`src/common/swagger/`](src/common/swagger/).

List endpoints return `{ data: [...], meta: { page, limit, total, totalPages } }` and accept
`page` (≥1) and `limit` (1–100; inventory allows up to 500).

| Method & path | Permission | Description |
| --- | --- | --- |
| **Auth** | | |
| `POST /auth/register` | public, rate-limited | Create account (no branch access yet); logs in |
| `POST /auth/login` | public, rate-limited | Access token + refresh cookie |
| `POST /auth/refresh` | refresh cookie, rate-limited | Rotate refresh cookie, new access token |
| `POST /auth/logout` | refresh cookie | Revoke session family |
| `GET /auth/me` | authenticated | Profile, memberships, effective permissions per branch |
| `PATCH /auth/me` | authenticated | Update your own name |
| `POST /auth/change-password` | authenticated, rate-limited | `{currentPassword, newPassword}`; revokes all sessions, returns a fresh one |
| **Users** | | |
| `POST /users` · `GET /users?q&isActive` · `GET /users/:id` · `PATCH /users/:id` | `USER_MANAGE` | Deactivation revokes sessions and evicts sockets |
| `POST /users/:id/password` | `USER_MANAGE` | Admin password reset (not for yourself); revokes the user's sessions |
| **Branches & members** | | |
| `POST /branches` · `PATCH /branches/:id` | `BRANCH_MANAGE` | |
| `GET /branches` · `GET /branches/:id` | member (all for admins) | Includes `myRole` |
| `GET /branches/:branchId/members` | `MEMBERS_READ` @branch | |
| `POST /branches/:branchId/members` · `PATCH|DELETE …/members/:userId` | `USER_MANAGE` | Cannot change your own membership |
| **Catalog** | | |
| `POST /categories` · `PATCH /categories/:id` · `DELETE /categories/:id` | `PRODUCT_MANAGE` | Delete → `409 CATEGORY_IN_USE` if referenced |
| `GET /categories` · `GET /categories/:id` | `CATALOG_READ` | With product counts |
| `POST /products` · `PATCH /products/:id` · `PATCH /products/:id/status` | `PRODUCT_MANAGE` | SKU unique (upper-cased); price decimal string; no stock fields |
| `GET /products?q&categoryId&isActive&sortBy&sortOrder` · `GET /products/:id` | `CATALOG_READ` | |
| **Inventory** | | |
| `GET /inventory?branchId&q&categoryId&lowStockOnly` | `INVENTORY_READ` | Snapshot with `version`, `isLowStock`, `snapshotAt` |
| `GET /inventory/:branchId/:productId` | `INVENTORY_READ` | Quantity 0 / version 0 if never stocked |
| `POST /inventory/receipts` | `STOCK_RECEIVE` | `{branchId, productId, quantity, note?, idempotencyKey}` |
| `POST /inventory/sales` | `SALE_CREATE` | `{branchId, productId, quantity, note?, idempotencyKey}` |
| `POST /inventory/adjustments` | `STOCK_ADJUST` | `{branchId, productId, delta (±, ≠0), reason, idempotencyKey}` |
| `POST /inventory/reversals` | `STOCK_REVERSE` | `{movementId, reason, idempotencyKey}`: compensates IN/SALE/ADJUSTMENT once |
| **Stock movements** (read-only ledger) | | |
| `GET /stock-movements?branchId&productId&type&referenceId&from&to` | `MOVEMENT_READ` | Newest first |
| `GET /stock-movements/:id` | `MOVEMENT_READ` @movement branch | |
| **Transfers** | | |
| `POST /transfers` | `TRANSFER_CREATE` @source | `{sourceBranchId, destinationBranchId, items:[{productId,quantity}], note?, idempotencyKey}` |
| `GET /transfers?branchId&direction=incoming|outgoing|all&status` | `TRANSFER_READ` | |
| `GET /transfers/:id` | `TRANSFER_READ` @either branch | |
| `POST /transfers/:id/complete` | `TRANSFER_APPROVE` @either | Atomic stock move |
| `POST /transfers/:id/cancel` | approver or creator | `{reason?}` |
| **Dashboard** | | |
| `GET /dashboard/summary?branchId` | `REPORT_READ` | Active products, units, low/out-of-stock counts, value, pending transfers, 24h movements |
| `GET /dashboard/low-stock?branchId&limit` | `REPORT_READ` | Most critical first |
| `GET /dashboard/recent-movements?branchId&limit` | `REPORT_READ` | |
| `GET /dashboard/stock-value?branchId` | `REPORT_READ` | Total + per category |
| **Other** | | |
| `GET /notifications?unreadOnly` · `GET /notifications/unread-count` · `PATCH /notifications/:id/read` · `POST /notifications/read-all` | own only | |
| `GET /audit-logs?userId&action&entityType&entityId&from&to` | `AUDIT_READ` | |
| `GET /health` | public | `503` if the database is unreachable |

**Write command responses** (`receipts`, `sales`, `adjustments`, `reversals`) are
`201 { movement, inventory: { branchId, productId, quantity, version, updatedAt }, lowStock }`,
with the header `Idempotent-Replayed: true|false`.

**Pricing / valuation rule:** stock value = Σ(on-hand quantity × the product's *current catalog
price*), active products only, computed in PostgreSQL `NUMERIC` and returned as a decimal string.
This is a retail-value estimate, not a cost basis (FIFO/average cost is out of scope).

**Low-stock rule:** a product is low in a branch when `minStock > 0` and `quantity ≤ minStock`.
Alerts (`inventory:low-stock` + notifications to the branch's ADMIN, MANAGER and WAREHOUSE_WORKER
members) fire only on the **transition** into low stock, not on every subsequent sale.

### curl walkthrough

```bash
API=http://localhost:3000/api

# 1. Log in (cookie jar keeps the HttpOnly refresh cookie)
TOKEN=$(curl -s -c jar.txt -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"seller@stockpulse.dev","password":"Seller12345!"}' | jq -r .accessToken)
AUTH="Authorization: Bearer $TOKEN"

# 2. Discover a branch and a product
BRANCH=$(curl -s $API/branches -H "$AUTH" | jq -r '.[] | select(.name=="Downtown Store").id')
PRODUCT=$(curl -s "$API/products?q=BEV-COLA" -H "$AUTH" | jq -r '.data[0].id')

# 3. Current stock (note the version)
curl -s "$API/inventory/$BRANCH/$PRODUCT" -H "$AUTH" | jq '{quantity, version}'

# 4. Sell 3 units. Re-running with the SAME key replays the result instead of selling again.
KEY="sale-$(uuidgen)"
curl -s -i -X POST $API/inventory/sales -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"branchId\":\"$BRANCH\",\"productId\":\"$PRODUCT\",\"quantity\":3,\"idempotencyKey\":\"$KEY\"}"

# 5. Refresh the access token using the cookie
curl -s -b jar.txt -c jar.txt -X POST $API/auth/refresh | jq '{expiresIn}'

# 6. Receipt (as the warehouse worker) and a transfer completed by the admin
W=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"warehouse@stockpulse.dev","password":"Warehouse12345!"}' | jq -r .accessToken)
curl -s -X POST $API/inventory/receipts -H "Authorization: Bearer $W" -H 'Content-Type: application/json' \
  -d "{\"branchId\":\"$BRANCH\",\"productId\":\"$PRODUCT\",\"quantity\":24,\"idempotencyKey\":\"rcpt-$(uuidgen)\"}" | jq .inventory

AIRPORT=$(curl -s $API/branches -H "$AUTH" | jq -r '.[] | select(.name=="Airport Kiosk").id')
TRANSFER=$(curl -s -X POST $API/transfers -H "Authorization: Bearer $W" -H 'Content-Type: application/json' \
  -d "{\"sourceBranchId\":\"$BRANCH\",\"destinationBranchId\":\"$AIRPORT\",\"items\":[{\"productId\":\"$PRODUCT\",\"quantity\":10}],\"idempotencyKey\":\"tr-$(uuidgen)\"}" | jq -r .id)
A=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@stockpulse.dev","password":"Admin12345!"}' | jq -r .accessToken)
curl -s -X POST $API/transfers/$TRANSFER/complete -H "Authorization: Bearer $A" | jq '{status, completedAt}'
```

---

## Socket.IO contract

Namespace **`/inventory`**. Authenticate in the handshake. Identity always comes from the
verified token, never from event payloads.

```ts
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000/inventory', {
  transports: ['websocket'],
  auth: (cb) => cb({ token: currentAccessToken }), // function → fresh token on every reconnect
});
```

`Authorization: Bearer <token>` in `extraHeaders` is accepted too (non-browser clients).

**Handshake failures** arrive as `connect_error` with `err.message` set to `UNAUTHORIZED` or
`TOKEN_EXPIRED` (`err.data = { code, message }`). Connections from origins outside the allowlist
are refused at the transport level. A socket is disconnected by the server when its access
token expires; reconnect with a refreshed token.

### Client → server

| Event | Payload | Ack |
| --- | --- | --- |
| `inventory:subscribe` | `{ "branchId": "uuid" }` | `{ ok: true, branchId }` or `{ ok: false, code: "FORBIDDEN" \| "VALIDATION_ERROR" \| "INVALID_BRANCH", message }` |
| `inventory:unsubscribe` | `{ "branchId": "uuid" }` | `{ ok: true, branchId }` |

Subscriptions run the same `BranchAccessService` check as REST (`INVENTORY_READ`). The server
joins the server-named room `branch:<uuid>`; clients cannot name rooms. Every socket also joins
its private `user:<id>` room automatically. When a membership is removed or changed, or a user is
deactivated, the server re-authorises that user's sockets right away (via the outbox). A 60 s
periodic sweep backs this up.

### Server → client

| Event | Room | Payload |
| --- | --- | --- |
| `inventory:updated` | `branch:<id>` | `{ eventId, branchId, productId, quantity, version, movementId, movementType, occurredAt }` |
| `inventory:low-stock` | `branch:<id>` | `{ eventId, branchId, productId, quantity, minStock, occurredAt }` |
| `transfer:updated` | `branch:<source>` and `branch:<destination>` | `{ eventId, transferId, sourceBranchId, destinationBranchId, status, occurredAt }` |
| `notification:new` | `user:<id>` | `{ id, type: "LOW_STOCK", branchId, title, message, createdAt }` |

`quantity` is the **absolute** on-hand quantity after the change. `version` increases by exactly
1 per change to that (branch, product). Types live in
[`src/realtime/events/event-contracts.ts`](src/realtime/events/event-contracts.ts).

### Recommended client algorithm

Implemented in [`examples/inventory-cache.ts`](examples/inventory-cache.ts) (unit-tested) and
used by the runnable demo [`examples/socket-client.ts`](examples/socket-client.ts):

1. On every `connect`: emit `inventory:subscribe` for each branch, **then** fetch
   `GET /inventory?branchId=…` and load it as the snapshot. Subscribing first means nothing
   committed in between is lost.
2. On `inventory:updated`: drop it if `eventId` was seen (duplicate) or `version ≤ cached`
   (stale or out of order). Otherwise apply it. If `version > cached + 1`, events were missed: the
   quantity is still correct (it is absolute), but refetch the snapshot anyway to resync.
3. On `disconnect`: mark caches stale. Socket.IO reconnects automatically. Rooms do not survive
   reconnection, so step 1 runs again.
4. On `connect_error` `TOKEN_EXPIRED`: call `/auth/refresh`, then `socket.connect()`.

Never order events by client time. Order only by the server `version`.

```bash
# Watch live events (API running + seeded), then run a sale from the curl walkthrough
API_URL=http://localhost:3000 EMAIL=manager.downtown@stockpulse.dev PASSWORD='Manager12345!' npm run socket:demo
```

---

## Consistency model

### Stock mutations

All changes go through `StockLedgerService`, inside a PostgreSQL transaction:

```sql
-- decrease (sale, transfer out, negative adjustment): matches 0 rows if stock is insufficient
UPDATE inventory SET quantity = quantity - $q, version = version + 1, updated_at = now()
 WHERE branch_id = $b AND product_id = $p AND quantity >= $q
RETURNING quantity, version;

-- increase (receipt, transfer in): race-free upsert
INSERT INTO inventory (...) VALUES (..., $q, 1, now())
ON CONFLICT (branch_id, product_id) DO UPDATE
  SET quantity = inventory.quantity + EXCLUDED.quantity, version = inventory.version + 1
RETURNING quantity, version;
```

A concurrent writer blocks on the row lock. Under READ COMMITTED, PostgreSQL then re-evaluates the
`WHERE` clause against the updated row, so a second sale sees the reduced quantity and matches zero
rows, which becomes `409 INSUFFICIENT_STOCK`. There is no read-then-write. A `CHECK (quantity >= 0)`
constraint backs this up.

In the same transaction: the `StockMovement` row (with `balanceAfter` and `inventoryVersion`), the
audit log entry, notifications, the idempotency record and the outbox events. Either all of them
commit or none do (covered by the rollback test).

### Transfers

`complete` first claims the transfer with
`UPDATE … SET status='COMPLETED' WHERE id=$1 AND status='PENDING'`. The row lock means that of
several concurrent complete/cancel calls exactly one wins. The others get
`TRANSFER_ALREADY_COMPLETED` / `TRANSFER_ALREADY_CANCELLED`. All inventory changes then run in one
global `(branchId, productId)` order, so opposite-direction transfers cannot deadlock (tested with
8 concurrent completions). Deadlocks and serialisation failures are still retried by
`PrismaService.runInTransaction` as a safety net. Any shortfall rolls the entire transfer back and
leaves it `PENDING`.

### Idempotency

Receipts, sales, adjustments, reversals and transfer creation require an `idempotencyKey`, scoped
per user. The key row is inserted **first** inside the business transaction. A concurrent
duplicate blocks on the unique index `(user_id, key)` until the first transaction ends:

- first commits → the duplicate hits a unique violation and **replays the stored response**
  (`Idempotent-Replayed: true`);
- first rolls back (e.g. insufficient stock) → the key was never stored, so the client can retry it;
- same key with a different payload or operation → `409 IDEMPOTENCY_CONFLICT`.

Keys are kept for 7 days. Transfer `complete`/`cancel` are naturally idempotent through the status
transition.

### Event delivery (transactional outbox)

1. Services stage events through `EventPublisher.publish(tx, events)`. That inserts
   `outbox_events` rows **in the business transaction**, so rolled-back work never produces events.
2. After any commit, `PrismaService` notifies the `OutboxDispatcher`. A 1 s poll is the fallback.
3. The dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, emits to the room, and marks them
   published. Failures are retried with exponential backoff (`attempts`, `last_error`,
   `next_attempt_at`).
4. Event ids are stable (outbox row id = `eventId`).

**Guarantees and non-guarantees.** Delivery to *currently connected* sockets is at-least-once,
and only for committed data. Socket.IO does **not** buffer events for disconnected clients, so a
client that was offline misses those events and must refetch the snapshot (step 1 above). There is
no event-history replay endpoint in this MVP. Recovery is by snapshot plus versions. Events may
arrive out of order across transactions, which `version` resolves.

---

## Error format and codes

Every HTTP error has the same shape. The `requestId` is echoed in the `X-Request-Id` header and
included in server logs.

```json
{
  "statusCode": 409,
  "code": "INSUFFICIENT_STOCK",
  "message": "Insufficient stock for this operation",
  "requestId": "0b6c7f0e-1a2b-4c3d-9e8f-123456789abc",
  "details": { "branchId": "…", "productId": "…", "requested": 7, "available": 3 }
}
```

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | DTO/query validation; `details` lists fields |
| `INVALID_BRANCH` | 400 | Same-branch transfer, missing/inactive destination, inactive branch |
| `UNAUTHORIZED` | 401 | Missing/invalid token, inactive account |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `INVALID_CURRENT_PASSWORD` | 400 | `change-password` with a wrong current password |
| `TOKEN_EXPIRED` | 401 | Expired access or refresh token |
| `REFRESH_TOKEN_REUSED` | 401 | Rotated refresh token presented again; family revoked |
| `FORBIDDEN` | 403 | Not a member / role lacks permission |
| `CSRF_ORIGIN_REJECTED` | 403 | Cookie endpoint called from a disallowed origin |
| `REGISTRATION_DISABLED` | 403 | `ALLOW_REGISTRATION=false` |
| `RESOURCE_NOT_FOUND` | 404 | Unknown route or entity (or entity in a branch you cannot read) |
| `DUPLICATE_SKU` | 409 | SKU already exists |
| `EMAIL_ALREADY_REGISTERED` | 409 | |
| `DUPLICATE_RESOURCE` | 409 | Other unique conflicts (branch/category name, membership) |
| `CATEGORY_IN_USE` | 409 | Deleting a referenced category |
| `PRODUCT_INACTIVE` | 409 | Stock operation on a deactivated product |
| `INSUFFICIENT_STOCK` | 409 | Would go negative |
| `IDEMPOTENCY_CONFLICT` | 409 | Key reused with a different payload |
| `CONCURRENT_MODIFICATION` | 409 | Transaction conflict that persisted after retries |
| `MOVEMENT_ALREADY_REVERSED` / `MOVEMENT_NOT_REVERSIBLE` | 409 | Reversal rules |
| `TRANSFER_ALREADY_COMPLETED` / `TRANSFER_ALREADY_CANCELLED` | 409 | Transfer state transitions |
| `RATE_LIMITED` | 429 | Too many auth requests |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected; no stack, SQL or internals are exposed |

Known Prisma errors are mapped to safe codes (`P2002` → duplicate codes, `P2025` → not found,
`P2034` → concurrent modification, CHECK violations → insufficient stock/validation). Unexpected
errors are logged with the request id, method, path and user id (JSON logs in production).

---

## Testing

```bash
docker compose up -d db          # tests need PostgreSQL; uses the separate stockpulse_test DB
npm run test:unit                # 62 unit tests, no database
npm run test:e2e                 # 102 integration / concurrency / Socket.IO tests (serial)
npm run test:all                 # both
npm run typecheck && npm run lint
```

**Test-database safety:** e2e tests load `.env.test` and **override** any `DATABASE_URL` already in
the environment. Both the loader and the table-truncation helper refuse to run unless the database
name ends in `_test`. Migrations are applied with `prisma migrate deploy` in the Jest global setup.

| Suite | Covers |
| --- | --- |
| unit `permissions`, `permissions.guard` | role matrix, policy switch, guard behaviour, malformed ids, inactive branches |
| unit `low-stock` | threshold and transition rules |
| unit `idempotency.service` | replay, conflict, race-loser replay, error propagation, canonical hashing |
| unit `inventory.validation` | DTO rules, ledger insufficient-stock mapping, inactive products |
| unit `prisma-error.mapper`, `audit-logs` | safe error mapping, secret stripping |
| unit `examples/inventory-cache` | duplicate / out-of-order / gap handling on the client |
| e2e `auth` | register/login, cookie flags, rotation, reuse detection, CSRF origin, logout, deactivation |
| e2e `authorization` | admin-only management, branch visibility, membership rules |
| e2e `catalog` | SKU uniqueness, price/quantity validation, soft delete, pagination/filtering |
| e2e `inventory` | receipt, sale, insufficient stock, **rollback**, idempotency, adjustments, reversals, low-stock, audit + movement records |
| e2e `transfers` | atomic completion, rollback on shortfall, double completion/cancellation, concurrent completes, deadlock-free opposite transfers |
| e2e `concurrency` | **10 stock vs two concurrent 7-unit sales (×5)**, 25-way oversell attempt, concurrent duplicate keys, conflicting keys, upsert races, mixed load ledger consistency |
| e2e `realtime` | valid/invalid/expired tokens, origin allowlist, unauthorized subscribe, payload identity spoofing, delivery isolation, unsubscribe, low-stock threshold events, no events on rollback, eviction on membership removal, **reconnect + snapshot recovery** |
| e2e `account` | change password (session revocation), profile update, admin password reset, category detail, unread count |
| e2e `swagger` | OpenAPI document: unique operation ids, response schemas, 401/403 coverage, permission notes |
| e2e `dashboard` | KPIs, valuation, low stock ordering, report authorization, audit-log access |

---

## Example: concurrent sales

Stock is 10. Two sellers each submit a sale of 7 at the same instant:

```text
T1: BEGIN; INSERT idempotency_keys(k1)        T2: BEGIN; INSERT idempotency_keys(k2)
T1: UPDATE inventory ... quantity >= 7  → 1 row (10→3), row locked
                                              T2: UPDATE inventory ... quantity >= 7  → waits on lock
T1: INSERT stock_movements, audit_logs, outbox_events; COMMIT
                                              T2: re-checks WHERE on new row: 3 >= 7 false → 0 rows
                                              T2: throw INSUFFICIENT_STOCK → ROLLBACK (key k2 discarded)
```

Result: one `201`, one `409 INSUFFICIENT_STOCK`; final stock 3; exactly one `SALE` movement; one
`inventory:updated` event (`quantity: 3, version: 1`). This exact scenario runs five times in
`test/concurrency.e2e-spec.ts`. If T2 had reused T1's key with the same payload, it would have
blocked on the key insert instead and received T1's stored response.

---

## Known MVP limitations

- **Single API instance for real-time.** Socket.IO uses the in-memory adapter. With several
  instances, add `@socket.io/redis-adapter` so `server.to(room).emit` reaches sockets on every
  node. The outbox already copes with several workers (`SKIP LOCKED`).
- **No event replay.** Missed events are recovered by refetching the snapshot, not by a
  cursor-based history API. The `stock_movements` ledger (with versions) could back one later.
- **Integer quantities** only; no units of measure conversion, batches, lots or expiry dates.
- **No stock reservation** for pending transfers: availability is re-checked at completion, and a
  short source branch makes completion fail atomically.
- **Valuation** uses the current list price, not historical cost.
- **ADMIN is organisation-wide** for management actions (any-branch ADMIN can manage users and
  grant themselves memberships; all such changes are audited). Stock access is still per branch.
- Rate limiting is in-memory (per instance); use a shared store behind a load balancer.
- Socket re-authorisation after a membership change is immediate through the outbox, with a 60 s
  sweep as a backup. A deactivated user's sockets are disconnected the same way.
- A password change or admin reset revokes all refresh tokens immediately, but access tokens already
  issued stay valid until they expire (≤ `JWT_ACCESS_TTL`, 15 min by default).
- Refresh-token reuse detection is strict: two simultaneous refreshes with the same cookie revoke
  the family. Clients must serialise refreshes.

---

## Deployment guidance

### Single-server production deploy (Docker Compose + Caddy)

Files: `docker-compose.prod.yml` (PostgreSQL, one-off `migrate` job, API, Caddy with automatic
Let's Encrypt HTTPS and WebSocket proxying), `deploy/Caddyfile`, `.env.production.example`,
and `scripts/` (`deploy.sh`, `create-admin.sh`, `backup-db.sh`). Only Caddy publishes ports
(80/443); the database and the API stay on the internal Docker network.

Requirements: a Linux server with Docker Engine + Compose v2, ports 80 and 443 open, and a DNS
record for the API domain (e.g. `api.example.com`) pointing at the server.

```bash
# on the server
git clone <repo> /opt/stockpulse && cd /opt/stockpulse   # or rsync the project
sudo ./scripts/server-setup.sh "$USER"   # fresh Ubuntu/Debian only: Docker, ufw, auto-updates, swap
cp .env.production.example .env.production
nano .env.production        # domain, frontend origin, DB password, two JWT secrets
./scripts/deploy.sh         # build image -> start db -> migrate -> start api + caddy
./scripts/create-admin.sh admin@yourcompany.com "Your Name" "Head Office" "Address"
curl -fsS https://api.example.com/api/health
```

- **Updating:** pull the new code and run `./scripts/deploy.sh` again. Migrations run before the
  new API container starts; a failed migration leaves the old container running.
- **First admin:** `create-admin.sh` runs `dist/seed/create-admin.js` in the API container. It is
  idempotent and safe in production; it creates the user, a branch (if missing) and an ADMIN
  membership. Re-run with `ADMIN_RESET_PASSWORD=true` to reset a forgotten admin password (this
  also revokes that user's refresh tokens). Then create other users in the app or via
  `POST /api/users`.
- **Backups:** `./scripts/backup-db.sh` writes `backups/stockpulse-<timestamp>.sql.gz` and keeps
  the last 14. Schedule it, e.g. `0 3 * * * /opt/stockpulse/scripts/backup-db.sh`. Copy backups
  off the server too. The restore command is in the script header.
- **CI:** `.github/workflows/ci.yml` runs typecheck, lint, format check, unit and e2e tests
  (PostgreSQL service) and a Docker build on every push to `main` and every pull request.
- **Logs:** all containers rotate logs (5 × 20 MB). `docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api`
- **Frontend:** set `FRONTEND_ORIGIN` to the exact frontend URL. Keep the frontend and API on the
  same registrable domain (`app.example.com` + `api.example.com`) so `COOKIE_SAMESITE=strict`
  works; otherwise use `COOKIE_SAMESITE=none`.

### General guidance

1. **Build** the image: `docker build -t stockpulse-api .` (multi-stage, non-root user, healthcheck
   on `/api/health`, `prisma` CLI included for migrations).
2. **Secrets:** provide `JWT_ACCESS_SECRET` / `REFRESH_TOKEN_SECRET` (distinct, ≥ 32 random chars)
   and `DATABASE_URL` from a secret manager. Never use the dev values from `docker-compose.yml`.
3. **Production env:** `NODE_ENV=production`, `COOKIE_SECURE=true` (enforced),
   `FRONTEND_ORIGIN=https://app.example.com` (explicit list), `TRUST_PROXY=<hops>`.
4. **HTTPS only**, terminated at a load balancer or reverse proxy that supports WebSockets
   (`Upgrade` headers, idle timeout above Socket.IO's 25 s ping interval). Sticky sessions are
   needed only if you enable the long-polling transport across instances.
5. **Migrations:** run `npx prisma migrate deploy` as a release step (the compose file does it on
   start for convenience). Never run the seed in production (it refuses).
6. **Graceful shutdown:** the app handles `SIGTERM`. It stops accepting connections, finishes the
   in-flight outbox batch, closes Socket.IO and disconnects Prisma. Give the container a ≥ 10 s
   stop grace period.
7. **Swagger** is disabled when `NODE_ENV=production`.
8. **Observability:** JSON logs include `requestId`. Monitor `outbox_events` rows where
   `published_at IS NULL AND attempts > 3` as a delivery-health signal.
9. **Scaling out:** add the Redis Socket.IO adapter and a shared throttler store, and size the
   Prisma pool (`?connection_limit=`) per instance against PostgreSQL `max_connections`.
# warehouse-backend
