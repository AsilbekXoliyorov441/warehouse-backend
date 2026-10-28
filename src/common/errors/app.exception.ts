import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export interface AppErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** An expected, client-safe error carrying a stable error code. */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details } satisfies AppErrorBody, status);
  }

  static notFound(resource: string): AppException {
    return new AppException(
      HttpStatus.NOT_FOUND,
      ErrorCode.RESOURCE_NOT_FOUND,
      `${resource} not found`,
    );
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppException {
    return new AppException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  static unauthorized(
    message = 'Authentication required',
    code = ErrorCode.UNAUTHORIZED,
  ): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static conflict(code: ErrorCode, message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.CONFLICT, code, message, details);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static insufficientStock(details?: unknown): AppException {
    return AppException.conflict(
      ErrorCode.INSUFFICIENT_STOCK,
      'Insufficient stock for this operation',
      details,
    );
  }
}
