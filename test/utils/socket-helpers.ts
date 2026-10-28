import { io, Socket } from 'socket.io-client';

export function connectSocket(
  baseUrl: string,
  token: string | undefined,
  extra: Record<string, unknown> = {},
): Socket {
  return io(`${baseUrl}/inventory`, {
    transports: ['websocket'],
    auth: token === undefined ? {} : { token },
    reconnection: false,
    forceNew: true,
    ...extra,
  });
}

export function waitForConnect(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForConnectError(
  socket: Socket,
  timeoutMs = 5000,
): Promise<Error & { data?: { code?: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected connect_error')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('unexpectedly connected'));
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

export function waitForEvent<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Collects every payload of `event` until stopped. */
export function collect<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
): { items: T[]; stop: () => void } {
  const items: T[] = [];
  const handler = (p: T) => items.push(p);
  socket.on(event, handler);
  return { items, stop: () => socket.off(event, handler) };
}

export function emitWithAck<T = { ok: boolean; code?: string; branchId?: string }>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return socket.timeout(5000).emitWithAck(event, payload) as Promise<T>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
