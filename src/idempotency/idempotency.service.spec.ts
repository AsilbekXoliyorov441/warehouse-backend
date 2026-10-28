import { Prisma } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { PrismaService } from '../prisma/prisma.service';
import { hashRequest, IdempotencyService, stableStringify } from './idempotency.service';

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['user_id', 'key'] },
  });
}

describe('IdempotencyService', () => {
  const params = {
    userId: 'u1',
    key: 'key-12345',
    operation: 'inventory.sale',
    payload: { branchId: 'b', productId: 'p', quantity: 2 },
  };
  let findUnique: jest.Mock;
  let runInTransaction: jest.Mock;
  let service: IdempotencyService;
  const tx = {
    idempotencyKey: { create: jest.fn().mockResolvedValue({ id: 'rec' }), update: jest.fn() },
  };

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(null);
    runInTransaction = jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    const prisma = { idempotencyKey: { findUnique }, runInTransaction } as unknown as PrismaService;
    service = new IdempotencyService(prisma);
    jest.clearAllMocks();
  });

  it('runs the work once and stores the JSON-normalised response', async () => {
    const work = jest.fn().mockResolvedValue({ at: new Date('2026-01-01T00:00:00Z'), n: 1 });
    const result = await service.execute(params, work);
    expect(result).toEqual({ replayed: false, body: { at: '2026-01-01T00:00:00.000Z', n: 1 } });
    expect(tx.idempotencyKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestHash: hashRequest(params.operation, params.payload),
        }),
      }),
    );
    expect(tx.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: 'rec' },
      data: { responseBody: { at: '2026-01-01T00:00:00.000Z', n: 1 }, statusCode: 201 },
    });
  });

  it('replays a stored response for the same payload without running the work', async () => {
    findUnique.mockResolvedValue({
      requestHash: hashRequest(params.operation, params.payload),
      responseBody: { ok: 1 },
    });
    const work = jest.fn();
    expect(await service.execute(params, work)).toEqual({ replayed: true, body: { ok: 1 } });
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different payload', async () => {
    findUnique.mockResolvedValue({
      requestHash: hashRequest(params.operation, { other: true }),
      responseBody: {},
    });
    await expect(service.execute(params, jest.fn())).rejects.toMatchObject({
      code: ErrorCode.IDEMPOTENCY_CONFLICT,
    });
  });

  it('rejects the same key used for a different operation', async () => {
    findUnique.mockResolvedValue({
      requestHash: hashRequest('inventory.receipt', params.payload),
      responseBody: {},
    });
    await expect(service.execute(params, jest.fn())).rejects.toBeInstanceOf(AppException);
  });

  it('replays the winner when losing a concurrent race on the unique key', async () => {
    findUnique
      .mockResolvedValueOnce(null) // fast-path check: nothing yet
      .mockResolvedValueOnce({
        requestHash: hashRequest(params.operation, params.payload),
        responseBody: { winner: true },
      });
    runInTransaction.mockRejectedValueOnce(uniqueViolation());
    expect(await service.execute(params, jest.fn())).toEqual({
      replayed: true,
      body: { winner: true },
    });
  });

  it('propagates business errors and does not store anything', async () => {
    const err = AppException.insufficientStock();
    await expect(service.execute(params, jest.fn().mockRejectedValue(err))).rejects.toBe(err);
    expect(tx.idempotencyKey.update).not.toHaveBeenCalled();
  });
});

describe('stableStringify', () => {
  it('is independent of key order and ignores undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, 2] }, b: 1 }),
    );
    expect(stableStringify({ a: [2, 1] })).not.toBe(stableStringify({ a: [1, 2] }));
  });
});
