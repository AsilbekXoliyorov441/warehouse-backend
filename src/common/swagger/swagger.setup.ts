import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type {
  OperationObject,
  ResponseObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { BranchRole } from '@prisma/client';
import { Permission, ROLE_PERMISSIONS } from '../constants/permissions';
import { ErrorCode } from '../errors/error-codes';
import { REALTIME_MODELS } from '../../realtime/events/event-docs';
import { errorDescription, errorExample } from './api-docs.decorators';
import { ApiErrorDto, BEARER_SCHEME, REFRESH_COOKIE_SCHEME } from './api-models';

const API_DESCRIPTION = `
Real-time, multi-branch inventory management API.

## Quick start
1. \`POST /api/auth/login\` with one of the seeded accounts (e.g. \`admin@stockpulse.dev\` / \`Admin12345!\`).
   This page captures the returned \`accessToken\` automatically, so **Try it out** works right away.
2. \`GET /api/auth/me\` lists your branches and the effective permissions in each.
3. Use a \`branchId\` from there for inventory, transfers and dashboard calls.

## Authentication
* **Access token**: short-lived JWT, send as \`Authorization: Bearer <token>\`. Keep it in memory.
* **Refresh token**: \`HttpOnly\` cookie \`sp_refresh\` scoped to \`/api/auth\`. \`POST /auth/refresh\`
  rotates it; presenting a rotated token revokes the whole session family (\`REFRESH_TOKEN_REUSED\`).
  Serialise refresh calls (one in flight per tab). Cookie endpoints check the \`Origin\` header
  against \`FRONTEND_ORIGIN\`.

## Authorization
Roles are granted **per branch** (\`ADMIN\`, \`MANAGER\`, \`WAREHOUSE_WORKER\`, \`SELLER\`). Every operation
below states the permission it needs and which roles hold it. Entities in branches you cannot read
are reported as \`404\`, not \`403\`.

## Conventions
* All list endpoints return \`{ data, meta: { page, limit, total, totalPages } }\` and accept \`page\` / \`limit\`.
* Money is a decimal **string** (\`"12.50"\`). Timestamps are ISO-8601 UTC.
* Unknown body properties are rejected (\`VALIDATION_ERROR\`).
* Every response carries \`X-Request-Id\`; send your own to correlate logs.

## Idempotency
Stock commands and transfer creation require a client-generated \`idempotencyKey\` (8–128 chars).
Retrying with the same key and payload returns the original result with \`Idempotent-Replayed: true\`;
the same key with a different payload is \`409 IDEMPOTENCY_CONFLICT\`. A failed request does not consume its key.

## Errors
Every error has the \`ApiError\` shape: \`{ statusCode, code, message, requestId, details? }\`.
Branch on \`code\`, never on \`message\`.

## Real-time (Socket.IO)
Namespace \`/inventory\`, authenticate with \`io(url + '/inventory', { auth: { token } })\`.

| Direction | Event | Payload schema |
| --- | --- | --- |
| client → server | \`inventory:subscribe\` / \`inventory:unsubscribe\` | \`InventorySubscribeRequest\` → ack \`InventorySubscribeAck\` |
| server → client | \`inventory:updated\` | \`InventoryUpdatedEvent\` |
| server → client | \`inventory:low-stock\` | \`LowStockEvent\` |
| server → client | \`transfer:updated\` | \`TransferUpdatedEvent\` |
| server → client | \`notification:new\` | \`NotificationNewEvent\` |

On every (re)connect: subscribe first, then fetch \`GET /inventory?branchId=…\`. Apply an
\`inventory:updated\` event only when its \`version\` is greater than the cached one.
`.trim();

const TAGS: [string, string][] = [
  ['auth', 'Sign-in, session rotation, profile and password'],
  ['users', 'User administration (ADMIN)'],
  ['branches', 'Branches visible to the caller'],
  ['branch-memberships', 'Who has which role in a branch'],
  ['categories', 'Product categories'],
  ['products', 'Product catalog (no stock fields; stock lives in inventory)'],
  ['inventory', 'Stock snapshots and stock commands: receipts, sales, adjustments, reversals'],
  ['stock-movements', 'Append-only stock ledger (read-only)'],
  ['transfers', 'Inter-branch transfers: PENDING → COMPLETED | CANCELLED'],
  ['dashboard', 'Branch KPIs and reports'],
  ['notifications', "The caller's notifications"],
  ['audit-logs', 'Audit trail (ADMIN)'],
  ['health', 'Liveness and readiness'],
];

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

interface PermissionExtension {
  permission: Permission;
  scope: 'organisation' | 'branch';
  source?: 'params' | 'query' | 'body';
  key?: string;
}

type DocumentedOperation = OperationObject & {
  'x-permission'?: PermissionExtension;
  'x-access'?: string;
  'x-idempotent'?: boolean;
};

const SUCCESS_DESCRIPTION: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '204': 'No Content',
};

function rolesWith(permission: Permission): string {
  const roles = (Object.keys(ROLE_PERMISSIONS) as BranchRole[]).filter((r) =>
    ROLE_PERMISSIONS[r].includes(permission),
  );
  const list = roles.map((r) => `\`${r}\``).join(', ');
  return permission === Permission.PRODUCT_MANAGE
    ? `${list} (+ \`MANAGER\` when \`MANAGERS_CAN_MANAGE_PRODUCTS=true\`)`
    : list;
}

function describePermission(ext: PermissionExtension): string {
  const where =
    ext.scope === 'branch'
      ? `in the branch given by \`${ext.key}\` (${ext.source === 'params' ? 'path' : ext.source})`
      : 'in at least one active branch';
  return `🔒 **Requires** \`${ext.permission}\` ${where}. Roles: ${rolesWith(ext.permission)}.`;
}

/** Adds (or extends) a documented error response for `status` with the given codes. */
function ensureErrorResponse(op: OperationObject, status: number, codes: ErrorCode[]): void {
  const key = String(status);
  const existing = op.responses[key] as ResponseObject | undefined;
  const examples = Object.fromEntries(codes.map((c) => [c, errorExample(c)]));
  if (!existing) {
    op.responses[key] = {
      description: errorDescription(codes),
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ApiErrorDto' }, examples },
      },
    };
    return;
  }
  const media = existing.content?.['application/json'];
  const missing = codes.filter((c) => !existing.description.includes(`\`${c}\``));
  if (missing.length === 0) return;
  existing.description = [existing.description, errorDescription(missing)]
    .filter(Boolean)
    .join(' · ');
  if (media) media.examples = { ...examples, ...media.examples };
}

/**
 * Enriches every operation from metadata the controllers already carry, so the docs cannot drift
 * from the enforced rules: permission notes, 400/401/403 responses and the X-Request-Id header.
 */
export function enrichDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.headers = {
    ...document.components.headers,
    'X-Request-Id': {
      description: 'Request correlation id (echoes a valid incoming X-Request-Id)',
      schema: { type: 'string', format: 'uuid' },
    },
  };

  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const op: DocumentedOperation | undefined = item[method];
      if (!op) continue;

      const security = op.security ?? [];
      const bearer = security.some((s) => BEARER_SCHEME in s);
      const cookie = security.some((s) => REFRESH_COOKIE_SCHEME in s);
      const notes: string[] = [];
      if (op['x-permission']) notes.push(describePermission(op['x-permission']));
      if (op['x-access']) notes.push(`🔒 **Access:** ${op['x-access']}`);
      if (bearer && notes.length === 0) notes.push('🔒 Any authenticated user.');
      if (!bearer && !cookie) notes.push('🌐 Public endpoint.');
      if (cookie) notes.push('🍪 Authenticated by the `sp_refresh` cookie (Origin-checked).');
      op.description = [op.description, ...notes].filter(Boolean).join('\n\n');

      const params = (op.parameters ?? []) as { in?: string }[];
      if (op.requestBody || params.some((p) => p.in === 'query' || p.in === 'path')) {
        ensureErrorResponse(op, 400, [ErrorCode.VALIDATION_ERROR]);
      }
      if (bearer) ensureErrorResponse(op, 401, [ErrorCode.UNAUTHORIZED, ErrorCode.TOKEN_EXPIRED]);
      if (op['x-permission'] || op['x-access']) {
        ensureErrorResponse(op, 403, [ErrorCode.FORBIDDEN]);
      }
      if (op['x-idempotent']) {
        ensureErrorResponse(op, 409, [
          ErrorCode.IDEMPOTENCY_CONFLICT,
          ErrorCode.CONCURRENT_MODIFICATION,
        ]);
      }

      for (const [status, response] of Object.entries(op.responses) as [string, ResponseObject][]) {
        if (!response.description) response.description = SUCCESS_DESCRIPTION[status] ?? '';
        response.headers = {
          ...response.headers,
          'X-Request-Id': { $ref: '#/components/headers/X-Request-Id' },
        };
      }
    }
  }
  return document;
}

/** Captures access tokens from auth responses so "Try it out" is authorized automatically. */
function captureAccessToken(res: {
  url: string;
  ok: boolean;
  obj?: { accessToken?: string };
}): unknown {
  try {
    if (res.ok && res.obj && res.obj.accessToken && /\/auth\//.test(res.url)) {
      // Runs in the browser, where globalThis is window and Swagger UI exposes `ui`.
      (
        globalThis as unknown as { ui: { preauthorizeApiKey: (n: string, v: string) => void } }
      ).ui.preauthorizeApiKey('bearer', res.obj.accessToken);
    }
  } catch {
    // best effort only
  }
  return res;
}

export function setupSwagger(app: INestApplication, prefix: string): void {
  const builder = new DocumentBuilder()
    .setTitle('StockPulse API')
    .setDescription(API_DESCRIPTION)
    .setVersion(process.env.npm_package_version ?? '1.0.0')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token' },
      BEARER_SCHEME,
    )
    .addCookieAuth(
      'sp_refresh',
      { type: 'apiKey', in: 'cookie', description: 'HttpOnly refresh cookie (path /api/auth)' },
      REFRESH_COOKIE_SCHEME,
    );
  for (const [name, description] of TAGS) builder.addTag(name, description);

  const document = SwaggerModule.createDocument(app, builder.build(), {
    extraModels: [ApiErrorDto, ...REALTIME_MODELS],
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '').replace(/^./, (c) => c.toLowerCase())}` +
      `${methodKey.replace(/^./, (c) => c.toUpperCase())}`,
  });

  SwaggerModule.setup(`${prefix}/docs`, app, enrichDocument(document), {
    jsonDocumentUrl: `${prefix}/docs-json`,
    yamlDocumentUrl: `${prefix}/docs-yaml`,
    customSiteTitle: 'StockPulse API Docs',
    customCss: '.swagger-ui .topbar { display: none } .swagger-ui .info { margin: 24px 0 }',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'none',
      filter: true,
      tryItOutEnabled: true,
      withCredentials: true,
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 3,
      operationsSorter: 'method',
      responseInterceptor: captureAccessToken,
    },
  });
}
