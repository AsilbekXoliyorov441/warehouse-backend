import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtension,
  ApiOkResponse,
  ApiResponse,
  ApiResponseExamples,
} from '@nestjs/swagger';
import { ERROR_STATUS, ErrorCode } from '../errors/error-codes';
import { ApiErrorDto, PageOf } from './api-models';

/** Example messages shown in the docs; the real message may be more specific. */
const EXAMPLE_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_ERROR: 'Request validation failed',
  INVALID_BRANCH: 'Source and destination branches must differ',
  INVALID_CURRENT_PASSWORD: 'Current password is incorrect',
  UNAUTHORIZED: 'Authentication required',
  INVALID_CREDENTIALS: 'Invalid email or password',
  TOKEN_EXPIRED: 'Access token expired',
  REFRESH_TOKEN_REUSED: 'Refresh token reuse detected; please sign in again',
  FORBIDDEN: 'You do not have permission to perform this action',
  CSRF_ORIGIN_REJECTED: 'Request origin is not allowed',
  REGISTRATION_DISABLED: 'Self-registration is disabled',
  RESOURCE_NOT_FOUND: 'Resource not found',
  EMAIL_ALREADY_REGISTERED: 'Email is already registered',
  DUPLICATE_SKU: 'A product with this SKU already exists',
  DUPLICATE_RESOURCE: 'A resource with this name already exists',
  CATEGORY_IN_USE: 'Category is assigned to products',
  PRODUCT_INACTIVE: 'Product is inactive',
  INSUFFICIENT_STOCK: 'Insufficient stock for this operation',
  IDEMPOTENCY_CONFLICT: 'Idempotency key was already used with a different request',
  CONCURRENT_MODIFICATION: 'The resource was modified concurrently; please retry',
  MOVEMENT_ALREADY_REVERSED: 'This movement has already been reversed',
  MOVEMENT_NOT_REVERSIBLE: 'Only IN, SALE and ADJUSTMENT movements can be reversed',
  TRANSFER_ALREADY_COMPLETED: 'Transfer has already been completed',
  TRANSFER_ALREADY_CANCELLED: 'Transfer has already been cancelled',
  RATE_LIMITED: 'Too many requests, please try again later',
  INTERNAL_SERVER_ERROR: 'Internal server error',
};

const EXAMPLE_REQUEST_ID = '0b6c7f0e-1a2b-4c3d-9e8f-123456789abc';

export function errorExample(code: ErrorCode): ApiResponseExamples {
  return {
    summary: code,
    value: {
      statusCode: ERROR_STATUS[code],
      code,
      message: EXAMPLE_MESSAGE[code],
      requestId: EXAMPLE_REQUEST_ID,
    },
  };
}

export function errorDescription(codes: readonly ErrorCode[]): string {
  return codes.map((c) => `\`${c}\``).join(' · ');
}

/**
 * Documents the error codes an endpoint can return, grouped into one response per HTTP status,
 * each with the shared ApiError schema and a selectable example per code.
 * 400 VALIDATION_ERROR, 401 and 403 are added automatically by the document post-processor.
 */
export function ApiErrors(...codes: ErrorCode[]): MethodDecorator & ClassDecorator {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus].map(([status, group]) =>
      ApiResponse({
        status,
        description: errorDescription(group),
        type: ApiErrorDto,
        examples: Object.fromEntries(group.map((c) => [c, errorExample(c)])),
      }),
    ),
  );
}

/** `200 { data: T[], meta }` */
export function ApiPage(model: Type<unknown>, description?: string): MethodDecorator {
  return ApiOkResponse({ type: PageOf(model), description });
}

const REPLAY_HEADER = {
  'Idempotent-Replayed': {
    description:
      '`true` when this response was replayed from an earlier request with the same idempotency key',
    schema: { type: 'string', enum: ['true', 'false'] },
  },
};

/** `201` for idempotent commands, with the Idempotent-Replayed header and idempotency errors. */
export function ApiIdempotentCreated(model: Type<unknown>, description?: string): MethodDecorator {
  return applyDecorators(
    ApiCreatedResponse({ type: model, description, headers: REPLAY_HEADER }),
    // The post-processor merges the idempotency 409s into any 409 the endpoint already documents.
    ApiExtension('x-idempotent', true),
  );
}

/**
 * Human-readable access rule for endpoints whose authorization is enforced in the service
 * (because the branch is derived from stored data). Rendered into the operation description.
 */
export function ApiAccess(rule: string): MethodDecorator {
  return ApiExtension('x-access', rule);
}
