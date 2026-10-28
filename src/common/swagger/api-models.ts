import { Type } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode } from '../errors/error-codes';

/** Security scheme names registered in the OpenAPI document. */
export const BEARER_SCHEME = 'bearer';
export const REFRESH_COOKIE_SCHEME = 'refresh-cookie';

/** The single error shape produced by AllExceptionsFilter for every HTTP failure. */
export class ApiErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ enum: ErrorCode, enumName: 'ErrorCode', example: ErrorCode.INSUFFICIENT_STOCK })
  code!: ErrorCode;

  @ApiProperty({ example: 'Insufficient stock for this operation' })
  message!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Echoed in the X-Request-Id response header and in server logs',
  })
  requestId!: string;

  @ApiPropertyOptional({
    description: 'Machine-readable context, e.g. the failing fields for VALIDATION_ERROR',
    example: { branchId: '…', productId: '…', requested: 7, available: 3 },
  })
  details?: unknown;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 57 }) total!: number;
  @ApiProperty({ example: 3 }) totalPages!: number;
}

/**
 * Builds a named `{ data: T[], meta }` schema so list endpoints document their exact item type.
 * The class name (e.g. `ProductPage`) becomes the schema name in the OpenAPI document.
 */
export function PageOf<T>(model: Type<T>): Type<{ data: T[]; meta: PaginationMetaDto }> {
  class Page {
    @ApiProperty({ type: [model] })
    data!: T[];

    @ApiProperty({ type: PaginationMetaDto })
    meta!: PaginationMetaDto;
  }
  Object.defineProperty(Page, 'name', { value: `${model.name.replace(/Dto$/, '')}Page` });
  return Page;
}

export class IdRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Downtown Store' }) name!: string;
}
