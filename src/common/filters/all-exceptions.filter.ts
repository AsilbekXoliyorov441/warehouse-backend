import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AppRequest } from '../interfaces/request-context.interface';
import { mapPrismaError } from './prisma-error.mapper';

export interface ApiErrorResponse {
  statusCode: number;
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.RESOURCE_NOT_FOUND,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

/** Produces the single API error shape for every HTTP failure. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // Gateway handlers return error acks themselves; anything reaching here is unexpected.
      this.logger.error(
        `Unhandled ${host.getType()} exception: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
      return;
    }
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AppRequest>();
    const res = ctx.getResponse<Response>();
    const body = this.toResponse(exception, req.requestId ?? 'unknown');

    if (body.statusCode >= 500) {
      this.logger.error(
        {
          msg: 'Unhandled exception',
          requestId: body.requestId,
          method: req.method,
          path: req.originalUrl,
          userId: req.user?.id,
          error: exception instanceof Error ? exception.message : String(exception),
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    res.status(body.statusCode).json(body);
  }

  private toResponse(exception: unknown, requestId: string): ApiErrorResponse {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        requestId,
        ...(exception.details !== undefined && { details: exception.details }),
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests, please try again later',
        requestId,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'object' && response !== null && 'message' in response
          ? response.message
          : exception.message;
      return {
        statusCode: status,
        code:
          STATUS_TO_CODE[status] ??
          (status >= 500 ? ErrorCode.INTERNAL_SERVER_ERROR : ErrorCode.VALIDATION_ERROR),
        message:
          status >= 500
            ? 'Internal server error'
            : Array.isArray(message)
              ? message.join('; ')
              : String(message),
        requestId,
      };
    }
    const mapped = mapPrismaError(exception);
    if (mapped) return this.toResponse(mapped, requestId);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      requestId,
    };
  }
}
