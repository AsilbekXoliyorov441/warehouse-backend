import { BranchInventoryCache } from './inventory-cache';

const ev = (version: number, quantity: number, eventId = `e${version}`) => ({
  eventId,
  branchId: 'b1',
  productId: 'p1',
  quantity,
  version,
});

describe('BranchInventoryCache (client reconciliation)', () => {
  let cache: BranchInventoryCache;
  beforeEach(() => {
    cache = new BranchInventoryCache('b1');
    cache.loadSnapshot([{ productId: 'p1', quantity: 10, version: 3 }]);
  });

  it('applies the next version', () => {
    expect(cache.apply(ev(4, 9))).toBe('applied');
    expect(cache.get('p1')).toEqual({ quantity: 9, version: 4 });
    expect(cache.needsResync).toBe(false);
  });

  it('ignores duplicate deliveries of the same event', () => {
    cache.apply(ev(4, 9));
    expect(cache.apply(ev(4, 9))).toBe('duplicate');
  });

  it('ignores out-of-order (older) events', () => {
    cache.apply(ev(5, 7, 'x'));
    expect(cache.apply(ev(4, 9))).toBe('stale');
    expect(cache.get('p1')).toEqual({ quantity: 7, version: 5 });
  });

  it('detects missing versions and requests a resync', () => {
    expect(cache.apply(ev(6, 2))).toBe('gap');
    expect(cache.get('p1')).toEqual({ quantity: 2, version: 6 });
    expect(cache.needsResync).toBe(true);
  });

  it('keeps events newer than a late snapshot', () => {
    cache.apply(ev(4, 9));
    cache.loadSnapshot([{ productId: 'p1', quantity: 10, version: 3 }]); // snapshot taken before v4
    expect(cache.get('p1')).toEqual({ quantity: 9, version: 4 });
  });

  it('ignores events for other branches', () => {
    expect(cache.apply({ ...ev(4, 1), branchId: 'b2' })).toBe('ignored');
  });

  it('a product first seen via event at version 1 is applied', () => {
    expect(
      cache.apply({ eventId: 'n', branchId: 'b1', productId: 'p2', quantity: 5, version: 1 }),
    ).toBe('applied');
  });
});
