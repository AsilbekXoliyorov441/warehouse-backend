import { crossedIntoLowStock, isLowStock } from './low-stock';

describe('low-stock calculation', () => {
  it('is low at or below the threshold', () => {
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(4, 5)).toBe(true);
    expect(isLowStock(0, 5)).toBe(true);
    expect(isLowStock(6, 5)).toBe(false);
  });

  it('never alerts when minStock is 0 (alerting disabled)', () => {
    expect(isLowStock(0, 0)).toBe(false);
    expect(crossedIntoLowStock(3, 0, 0)).toBe(false);
  });

  it('fires only on the transition into low stock', () => {
    expect(crossedIntoLowStock(10, 5, 5)).toBe(true); // reached threshold
    expect(crossedIntoLowStock(10, 2, 5)).toBe(true); // jumped below
    expect(crossedIntoLowStock(10, 6, 5)).toBe(false); // still above
    expect(crossedIntoLowStock(5, 3, 5)).toBe(false); // already low
    expect(crossedIntoLowStock(3, 8, 5)).toBe(false); // recovered
    expect(crossedIntoLowStock(3, 4, 5)).toBe(false); // increased but still low
  });
});
