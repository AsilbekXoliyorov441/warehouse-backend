import { MovementDirection, MovementType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ErrorCode } from '../common/errors/error-codes';
import type { NotificationsService } from '../notifications/notifications.service';
import type { Tx } from '../prisma/prisma.service';
import { StockLedgerService } from '../stock-movements/stock-ledger.service';
import { AdjustmentDto, ReceiptDto, SaleDto } from './dto/inventory.dto';

const ids = {
  branchId: '3f1c4a5e-8b7d-4c2a-9e1f-0a1b2c3d4e5f',
  productId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
};
const errorsFor = async <T extends object>(cls: new () => T, body: object) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map(
    (e) => e.property,
  );

describe('inventory command validation', () => {
  it('accepts a well-formed sale', async () => {
    expect(
      await errorsFor(SaleDto, { ...ids, quantity: 3, idempotencyKey: 'unique-operation-key' }),
    ).toEqual([]);
  });

  it.each([0, -1, 2.5, '3', 1_000_001, null])('rejects sale quantity %p', async (quantity) => {
    expect(
      await errorsFor(SaleDto, { ...ids, quantity, idempotencyKey: 'unique-operation-key' }),
    ).toContain('quantity');
  });

  it('requires a well-formed idempotency key', async () => {
    expect(await errorsFor(ReceiptDto, { ...ids, quantity: 1 })).toContain('idempotencyKey');
    expect(await errorsFor(ReceiptDto, { ...ids, quantity: 1, idempotencyKey: 'short' })).toContain(
      'idempotencyKey',
    );
    expect(
      await errorsFor(ReceiptDto, { ...ids, quantity: 1, idempotencyKey: 'has spaces in it' }),
    ).toContain('idempotencyKey');
  });

  it('rejects non-UUID branch and product ids', async () => {
    const errs = await errorsFor(SaleDto, {
      branchId: 'b1',
      productId: 'p1',
      quantity: 1,
      idempotencyKey: 'unique-operation-key',
    });
    expect(errs).toEqual(expect.arrayContaining(['branchId', 'productId']));
  });

  it('rejects unknown properties such as client-supplied user ids', async () => {
    expect(
      await errorsFor(SaleDto, {
        ...ids,
        quantity: 1,
        idempotencyKey: 'unique-operation-key',
        createdBy: 'someone',
      }),
    ).toContain('createdBy');
  });

  it('requires a non-zero delta and an explicit reason for adjustments', async () => {
    expect(
      await errorsFor(AdjustmentDto, {
        ...ids,
        delta: 0,
        reason: 'count',
        idempotencyKey: 'unique-operation-key',
      }),
    ).toContain('delta');
    expect(
      await errorsFor(AdjustmentDto, { ...ids, delta: -2, idempotencyKey: 'unique-operation-key' }),
    ).toContain('reason');
    expect(
      await errorsFor(AdjustmentDto, {
        ...ids,
        delta: -2,
        reason: 'ok',
        idempotencyKey: 'unique-operation-key',
      }),
    ).toContain('reason');
    expect(
      await errorsFor(AdjustmentDto, {
        ...ids,
        delta: -2,
        reason: 'damaged',
        idempotencyKey: 'unique-operation-key',
      }),
    ).toEqual([]);
  });
});

describe('StockLedgerService', () => {
  const publish = jest.fn();
  const ledger = new StockLedgerService({ publish }, {
    notifyLowStock: jest.fn(),
  } as unknown as NotificationsService);
  const product = { id: ids.productId, sku: 'S', name: 'N', minStock: 0 };
  const change = {
    ...ids,
    type: MovementType.SALE,
    direction: MovementDirection.DECREASE,
    quantity: 5,
    createdBy: 'u',
  };

  it('maps a zero-row conditional decrement to INSUFFICIENT_STOCK with the available quantity', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      inventory: { findUnique: jest.fn().mockResolvedValue({ quantity: 2 }) },
      stockMovement: { create: jest.fn() },
    } as unknown as Tx;
    await expect(ledger.apply(tx, change, product)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_STOCK,
      details: { requested: 5, available: 2 },
    });
    expect(
      (tx as unknown as { stockMovement: { create: jest.Mock } }).stockMovement.create,
    ).not.toHaveBeenCalled();
  });

  it('rejects non-positive quantities before touching the database', async () => {
    const tx = { $queryRaw: jest.fn() } as unknown as Tx;
    await expect(ledger.apply(tx, { ...change, quantity: 0 }, product)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect((tx as unknown as { $queryRaw: jest.Mock }).$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects inactive products', async () => {
    const tx = {
      product: { findUnique: jest.fn().mockResolvedValue({ ...product, isActive: false }) },
    } as unknown as Tx;
    await expect(ledger.getActiveProduct(tx, ids.productId)).rejects.toMatchObject({
      code: ErrorCode.PRODUCT_INACTIVE,
    });
    await expect(ledger.getActiveProduct(tx, ids.productId, false)).resolves.toBeDefined();
  });
});
