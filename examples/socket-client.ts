/**
 * Runnable Socket.IO client demonstrating the recommended real-time flow:
 *   login -> connect (token in handshake) -> subscribe -> fetch snapshot -> apply versioned events,
 *   with automatic reconnection, re-subscription, snapshot refetch and access-token refresh.
 *
 * Usage (API running, database seeded):
 *   API_URL=http://localhost:3000 EMAIL=manager.downtown@stockpulse.dev PASSWORD=Manager12345! npm run socket:demo
 * Then record a sale or receipt (see README curl examples) and watch the events arrive.
 */
import { io, Socket } from 'socket.io-client';
import { BranchInventoryCache, SnapshotRow } from './inventory-cache';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.EMAIL ?? 'manager.downtown@stockpulse.dev';
const PASSWORD = process.env.PASSWORD ?? 'Manager12345!';

let accessToken = '';
let refreshCookie = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Cookie: refreshCookie,
      ...init.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.startsWith('sp_refresh=')) refreshCookie = setCookie.split(';')[0];
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function login(): Promise<void> {
  const body = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  accessToken = body.accessToken;
}

async function refresh(): Promise<void> {
  const body = await api<{ accessToken: string }>('/auth/refresh', { method: 'POST' });
  accessToken = body.accessToken;
  console.log('[auth] access token refreshed');
}

async function fetchSnapshot(branchId: string): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  for (let page = 1; ; page++) {
    const res = await api<{ data: SnapshotRow[]; meta: { totalPages: number } }>(
      `/inventory?branchId=${branchId}&limit=500&page=${page}`,
    );
    rows.push(...res.data);
    if (page >= res.meta.totalPages) return rows;
  }
}

async function main(): Promise<void> {
  await login();
  const me = await api<{ memberships: { branchId: string; branchName: string }[] }>('/auth/me');
  const caches = new Map(
    me.memberships.map((m) => [m.branchId, new BranchInventoryCache(m.branchId)]),
  );
  console.log(
    `[auth] logged in as ${EMAIL}; branches: ${me.memberships.map((m) => m.branchName).join(', ')}`,
  );

  const socket: Socket = io(`${API_URL}/inventory`, {
    transports: ['websocket'],
    // A function, so every (re)connection attempt sends the *current* token.
    auth: (cb) => cb({ token: accessToken }),
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });

  const resync = async (cache: BranchInventoryCache) => {
    cache.loadSnapshot(await fetchSnapshot(cache.branchId));
    console.log(`[sync] snapshot loaded for ${cache.branchId}`);
  };

  socket.on('connect', async () => {
    console.log(`[socket] connected (${socket.id})`);
    // Subscribe first, then fetch the snapshot: events that arrive in between are merged by version.
    for (const cache of caches.values()) {
      cache.invalidate();
      const ack = (await socket.emitWithAck('inventory:subscribe', {
        branchId: cache.branchId,
      })) as { ok: boolean; code?: string };
      if (!ack.ok) console.warn(`[socket] subscribe ${cache.branchId} refused: ${ack.code}`);
      else await resync(cache);
    }
  });

  socket.on('connect_error', async (err: Error & { data?: { code?: string } }) => {
    console.warn(`[socket] connect_error: ${err.message}`);
    // Middleware rejections are not retried automatically; refresh and reconnect explicitly.
    if (err.message === 'TOKEN_EXPIRED' || err.message === 'UNAUTHORIZED') {
      try {
        await refresh();
      } catch {
        await login();
      }
      socket.connect();
    }
  });

  socket.on('disconnect', async (reason) => {
    console.warn(`[socket] disconnected: ${reason}`);
    for (const cache of caches.values()) cache.invalidate();
    // "io server disconnect" = server closed us (e.g. token expiry); reconnect with a fresh token.
    if (reason === 'io server disconnect') {
      await refresh().catch(login);
      socket.connect();
    }
  });

  socket.on(
    'inventory:updated',
    (event: {
      eventId: string;
      branchId: string;
      productId: string;
      quantity: number;
      version: number;
    }) => {
      const cache = caches.get(event.branchId);
      if (!cache) return;
      const outcome = cache.apply(event);
      console.log(
        `[event] inventory:updated ${event.productId} qty=${event.quantity} v${event.version} -> ${outcome}`,
      );
      if (outcome === 'gap') void resync(cache);
    },
  );
  socket.on('inventory:low-stock', (e: { productId: string; quantity: number; minStock: number }) =>
    console.log(`[event] LOW STOCK ${e.productId}: ${e.quantity} <= ${e.minStock}`),
  );
  socket.on('notification:new', (n: { title: string; message: string }) =>
    console.log(`[event] notification: ${n.title} — ${n.message}`),
  );
  socket.on('transfer:updated', (t: { transferId: string; status: string }) =>
    console.log(`[event] transfer ${t.transferId} -> ${t.status}`),
  );

  process.on('SIGINT', () => {
    socket.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
