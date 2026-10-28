import { Prisma } from '@prisma/client';
import { ErrorCode } from '../errors/error-codes';
import { mapPrismaError } from './prisma-error.mapper';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

describe('mapPrismaError', () => {
  it.each([
    [known('P2002', { target: ['sku'] }), ErrorCode.DUPLICATE_SKU, 409],
    [known('P2002', { target: ['email'] }), ErrorCode.EMAIL_ALREADY_REGISTERED, 409],
    [known('P2002', { target: ['name'] }), ErrorCode.DUPLICATE_RESOURCE, 409],
    [known('P2025'), ErrorCode.RESOURCE_NOT_FOUND, 404],
    [known('P2034'), ErrorCode.CONCURRENT_MODIFICATION, 409],
    [
      new Error('new row violates check constraint "inventory_quantity_non_negative"'),
      ErrorCode.INSUFFICIENT_STOCK,
      409,
    ],
  ])('maps %s', (err, code, status) => {
    const mapped = mapPrismaError(err);
    expect(mapped?.code).toBe(code);
    expect(mapped?.getStatus()).toBe(status);
  });

  it('leaves unknown errors unmapped (handled as generic 500 without details)', () => {
    expect(mapPrismaError(known('P1001'))).toBeUndefined();
    expect(mapPrismaError(new Error('connection reset'))).toBeUndefined();
  });
});
