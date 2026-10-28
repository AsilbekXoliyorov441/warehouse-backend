import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { Permission } from '../common/constants/permissions';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { extractBearerToken } from '../common/guards/jwt-auth.guard';
import { isUuid } from '../common/utils/uuid';
import { UsersService } from '../users/users.service';
import { ClientEvents, Rooms, SubscribeAck } from './events/event-contracts';

export const INVENTORY_NAMESPACE = '/inventory';
const BRANCH_ROOM_PREFIX = 'branch:';
const REAUTHORIZE_INTERVAL_MS = 60_000;

interface SocketData {
  userId: string;
  tokenExpiresAt: number;
  expiryTimer?: NodeJS.Timeout;
}

type AppSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/**
 * Real-time delivery only: no business logic lives here. Clients authenticate during the
 * handshake and may join branch rooms they are authorised for; everything else is server-driven.
 */
@WebSocketGateway({ namespace: INVENTORY_NAMESPACE })
export class InventoryGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryGateway.name);
  private reauthorizeTimer?: NodeJS.Timeout;

  @WebSocketServer()
  private server?: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly access: BranchAccessService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.authenticate(socket as AppSocket)
        .then(() => next())
        .catch((err: unknown) => {
          const code = err instanceof AppException ? err.code : ErrorCode.UNAUTHORIZED;
          const error = new Error(code) as Error & { data?: unknown };
          error.data = {
            code,
            message: err instanceof AppException ? err.message : 'Authentication failed',
          };
          next(error);
        });
    });
    this.reauthorizeTimer = setInterval(() => void this.reauthorizeAll(), REAUTHORIZE_INTERVAL_MS);
    this.reauthorizeTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.reauthorizeTimer);
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    // Personal room for user-targeted events such as notification:new.
    await socket.join(Rooms.user(socket.data.userId));
    // Disconnect when the access token expires; the client reconnects with a fresh token.
    const ttl = Math.max(0, socket.data.tokenExpiresAt - Date.now());
    socket.data.expiryTimer = setTimeout(() => socket.disconnect(true), Math.min(ttl, 2 ** 31 - 1));
  }

  handleDisconnect(socket: AppSocket): void {
    clearTimeout(socket.data.expiryTimer);
  }

  @SubscribeMessage(ClientEvents.SUBSCRIBE)
  async subscribe(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeAck> {
    const branchId = this.readBranchId(body);
    if (!branchId)
      return { ok: false, code: ErrorCode.VALIDATION_ERROR, message: 'branchId must be a UUID' };
    try {
      await this.access.assertBranchPermission(
        socket.data.userId,
        branchId,
        Permission.INVENTORY_READ,
      );
    } catch (err) {
      if (err instanceof AppException)
        return { ok: false, branchId, code: err.code, message: err.message };
      this.logger.error(`Subscription check failed: ${(err as Error).message}`);
      return {
        ok: false,
        branchId,
        code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: 'Subscription failed',
      };
    }
    await socket.join(Rooms.branch(branchId));
    return { ok: true, branchId };
  }

  @SubscribeMessage(ClientEvents.UNSUBSCRIBE)
  async unsubscribe(
    @ConnectedSocket() socket: AppSocket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeAck> {
    const branchId = this.readBranchId(body);
    if (!branchId)
      return { ok: false, code: ErrorCode.VALIDATION_ERROR, message: 'branchId must be a UUID' };
    await socket.leave(Rooms.branch(branchId));
    return { ok: true, branchId };
  }

  /** Called by the outbox dispatcher. Throws if the server is not ready so the event is retried. */
  deliver(eventName: string, room: string, payload: unknown): void {
    if (!this.server) throw new Error('Socket.IO server not initialised');
    this.server.to(room).emit(eventName, payload);
  }

  /** Re-checks every branch room of the user's sockets; disconnects deactivated users. */
  async reauthorizeUser(userId: string): Promise<void> {
    if (!this.server) return;
    const sockets = (await this.server
      .in(Rooms.user(userId))
      .fetchSockets()) as unknown as AppSocket[];
    if (sockets.length === 0) return;
    if (!(await this.users.findActiveIdentity(userId))) {
      for (const s of sockets) s.disconnect(true);
      return;
    }
    const allowed = new Set(
      await this.access.branchIdsWithPermission(userId, Permission.INVENTORY_READ),
    );
    for (const s of sockets) {
      for (const room of s.rooms) {
        if (
          room.startsWith(BRANCH_ROOM_PREFIX) &&
          !allowed.has(room.slice(BRANCH_ROOM_PREFIX.length))
        ) {
          await s.leave(room);
        }
      }
    }
  }

  /** Periodic safety net in case an access-changed event is ever missed. */
  private async reauthorizeAll(): Promise<void> {
    if (!this.server) return;
    const userIds = new Set(
      [...this.server.sockets.values()].map((s) => (s as AppSocket).data.userId),
    );
    for (const userId of userIds) {
      try {
        await this.reauthorizeUser(userId);
      } catch (err) {
        this.logger.warn(`Re-authorisation failed for ${userId}: ${(err as Error).message}`);
      }
    }
  }

  private async authenticate(socket: AppSocket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token =
      (typeof auth?.token === 'string' ? auth.token.replace(/^Bearer\s+/i, '') : undefined) ??
      extractBearerToken(socket.handshake.headers.authorization);
    if (!token) throw AppException.unauthorized('Missing access token');
    const claims = await this.tokens.verifyAccessTokenClaims(token);
    const user = await this.users.findActiveIdentity(claims.userId);
    if (!user) throw AppException.unauthorized('Account is inactive or no longer exists');
    socket.data.userId = user.id;
    socket.data.tokenExpiresAt = claims.expiresAt;
  }

  private readBranchId(body: unknown): string | undefined {
    const branchId = (body as { branchId?: unknown } | null)?.branchId;
    return isUuid(branchId) ? branchId : undefined;
  }
}
