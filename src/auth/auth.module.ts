import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { BranchMembershipsModule } from '../branch-memberships/branch-memberships.module';
import { AppConfigService } from '../config/app-config.service';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JWT_AUDIENCE, JWT_ISSUER, TokenService } from './token.service';

@Global()
@Module({
  imports: [
    UsersModule,
    BranchMembershipsModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.get('JWT_ACCESS_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.get('JWT_ACCESS_TTL') as `${number}${'s' | 'm' | 'h'}`,
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      }),
    }),
    // Only routes decorated with ThrottlerGuard (login, refresh, register) are rate-limited.
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        {
          name: 'default',
          ttl: config.get('AUTH_RATE_TTL_SECONDS') * 1000,
          limit: config.get('AUTH_RATE_LIMIT'),
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [TokenService, UsersModule, BranchMembershipsModule],
})
export class AuthModule {}
