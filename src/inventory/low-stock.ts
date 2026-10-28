/**
 * Low-stock rule: a product is low in a branch when alerting is enabled for it (minStock > 0)
 * and the on-hand quantity is at or below minStock.
 */
export function isLowStock(quantity: number, minStock: number): boolean {
  return minStock > 0 && quantity <= minStock;
}

/**
 * Alerts fire on the *transition* into low stock only, so a branch that is already low does not
 * get a new alert on every subsequent sale.
 */
export function crossedIntoLowStock(
  previousQuantity: number,
  newQuantity: number,
  minStock: number,
): boolean {
  return !isLowStock(previousQuantity, minStock) && isLowStock(newQuantity, minStock);
}
