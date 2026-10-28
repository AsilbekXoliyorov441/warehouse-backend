import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Translates known Prisma errors into safe application errors. Returns undefined for errors
 * that should be treated as unexpected (and logged as 500s).
 */
export function mapPrismaError(err: unknown): AppException | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = ([] as string[]).concat((err.meta?.target as string[] | string) ?? []);
        if (target.some((t) => t.includes('sku'))) {
          return AppException.conflict(
            ErrorCode.DUPLICATE_SKU,
            'A product with this SKU already exists',
          );
        }
        if (target.some((t) => t.includes('email'))) {
          return AppException.conflict(
            ErrorCode.EMAIL_ALREADY_REGISTERED,
            'Email is already registered',
          );
        }
        return AppException.conflict(ErrorCode.DUPLICATE_RESOURCE, 'Resource already exists');
      }
      case 'P2025':
        return AppException.notFound('Resource');
      case 'P2003':
        return AppException.badRequest(
          ErrorCode.VALIDATION_ERROR,
          'Referenced resource does not exist',
        );
      case 'P2034':
        return AppException.conflict(
          ErrorCode.CONCURRENT_MODIFICATION,
          'The operation conflicted with a concurrent change; please retry',
        );
      default:
        return undefined;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    // Indicates a programming error, not bad client input; surface as 500 without details.
    return undefined;
  }
  if (err instanceof Error && /violates check constraint/.test(err.message)) {
    if (/inventory_quantity_non_negative|balance_non_negative/.test(err.message)) {
      return AppException.insufficientStock();
    }
    return new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'Invalid value');
  }
  return undefined;
}
