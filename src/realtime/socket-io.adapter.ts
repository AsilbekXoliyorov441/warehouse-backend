import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO server with the same origin rule as HTTP CORS (FRONTEND_ORIGIN). `allowRequest` also
 * rejects cross-origin WebSocket upgrades, which CORS alone does not cover.
 */
export class ConfiguredSocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly isOriginAllowed: (origin: string) => boolean,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const allowed = (origin: string | undefined): boolean =>
      !origin || this.isOriginAllowed(origin);
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) =>
          cb(null, allowed(origin)),
        credentials: false,
      },
      allowRequest: (req, callback) => {
        callback(null, allowed(req.headers.origin));
      },
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
    } satisfies Partial<ServerOptions>);
  }
}
