/**
 * Reference client-side cache for one branch's inventory. Framework-agnostic; a frontend would
 * wrap it in its state store. Rules:
 *
 *  - The REST snapshot (GET /api/inventory) is authoritative and replaces the cache.
 *  - Events carry absolute quantities plus a per-(branch, product) version. An event is applied
 *    only if its version is newer than the cached one, so duplicates and out-of-order deliveries
 *    are harmless. Client clocks are never used for ordering.
 *  - A version jump (> cached + 1) means events were missed. The newest absolute quantity is
 *    still correct, but anything derived from intermediate events may not be, so the cache asks
 *    for a resync (refetch the snapshot).
 */

export interface InventoryEvent {
  eventId: string;
  branchId: string;
  productId: string;
  quantity: number;
  version: number;
}

export interface SnapshotRow {
  productId: string;
  quantity: number;
  version: number;
}

export type ApplyOutcome = 'applied' | 'duplicate' | 'stale' | 'gap' | 'ignored';

const MAX_REMEMBERED_EVENTS = 2000;

export class BranchInventoryCache {
  private readonly items = new Map<string, { quantity: number; version: number }>();
  private readonly seenEventIds = new Set<string>();
  private resyncRequired = true;

  constructor(readonly branchId: string) {}

  get needsResync(): boolean {
    return this.resyncRequired;
  }

  /** Marks the cache stale, e.g. after a disconnect. */
  invalidate(): void {
    this.resyncRequired = true;
  }

  loadSnapshot(rows: SnapshotRow[]): void {
    // Merge rather than blindly replace: an event received between subscribing and the snapshot
    // response may already be newer than the snapshot row.
    const next = new Map<string, { quantity: number; version: number }>();
    for (const row of rows) {
      const cached = this.items.get(row.productId);
      next.set(
        row.productId,
        cached && cached.version > row.version
          ? cached
          : { quantity: row.quantity, version: row.version },
      );
    }
    this.items.clear();
    for (const [k, v] of next) this.items.set(k, v);
    this.resyncRequired = false;
  }

  apply(event: InventoryEvent): ApplyOutcome {
    if (event.branchId !== this.branchId) return 'ignored';
    if (this.seenEventIds.has(event.eventId)) return 'duplicate';
    this.remember(event.eventId);

    const cached = this.items.get(event.productId);
    if (cached && event.version <= cached.version) return 'stale';

    const expected = (cached?.version ?? 0) + 1;
    this.items.set(event.productId, { quantity: event.quantity, version: event.version });
    if (event.version > expected) {
      this.resyncRequired = true;
      return 'gap';
    }
    return 'applied';
  }

  get(productId: string): { quantity: number; version: number } | undefined {
    return this.items.get(productId);
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > MAX_REMEMBERED_EVENTS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
