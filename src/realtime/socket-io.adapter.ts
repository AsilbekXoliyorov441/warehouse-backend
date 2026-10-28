import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO server with the same explicit origin allowlist as HTTP CORS. `allowRequest` also
 * rejects cross-origin WebSocket upgrades, which CORS alone does not cover.
 */
export class ConfiguredSocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.allowedOrigins, credentials: false },
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        callback(null, !origin || this.allowedOrigins.includes(origin));
      },
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
    } satisfies Partial<ServerOptions>);
  }
}
