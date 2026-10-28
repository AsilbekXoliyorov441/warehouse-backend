import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import { CsrfOriginGuard } from '../common/guards/csrf-origin.guard';
import { ApiErrors } from '../common/swagger/api-docs.decorators';
import { REFRESH_COOKIE_SCHEME } from '../common/swagger/api-models';
import type { AppRequest, AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { AppConfigService } from '../config/app-config.service';
import { AuthService, IssuedSession } from './auth.service';
import {
  AuthTokenResponse,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { MeDto } from './dto/me.response';

export const REFRESH_COOKIE = 'sp_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';
const SETS_COOKIE = {
  'Set-Cookie': {
    description: '`sp_refresh=<token>; HttpOnly; SameSite; Path=/api/auth` (rotated refresh token)',
    schema: { type: 'string' },
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('register')
  @ApiOperation({
    summary: 'Register an account',
    description:
      'Creates an account and signs it in. New accounts have no branch access until an admin grants a membership. Rate-limited per IP.',
  })
  @ApiCreatedResponse({ type: AuthTokenResponse, headers: SETS_COOKIE })
  @ApiErrors(
    ErrorCode.EMAIL_ALREADY_REGISTERED,
    ErrorCode.REGISTRATION_DISABLED,
    ErrorCode.RATE_LIMITED,
  )
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    return this.respond(res, await this.auth.register(dto));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in',
    description:
      'Returns a short-lived access token and sets the HttpOnly refresh cookie. Unknown email and wrong password are indistinguishable. Rate-limited per IP.',
  })
  @ApiOkResponse({ type: AuthTokenResponse, headers: SETS_COOKIE })
  @ApiErrors(ErrorCode.INVALID_CREDENTIALS, ErrorCode.RATE_LIMITED)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    return this.respond(res, await this.auth.login(dto));
  }

  @Public()
  @UseGuards(CsrfOriginGuard, ThrottlerGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE_SCHEME)
  @ApiOperation({
    summary: 'Refresh the access token',
    description:
      'Single-use rotation: the presented cookie is revoked and a new one is set. Re-using a rotated token revokes the whole session family. Serialise calls (one in flight per tab).',
  })
  @ApiOkResponse({ type: AuthTokenResponse, headers: SETS_COOKIE })
  @ApiErrors(
    ErrorCode.UNAUTHORIZED,
    ErrorCode.TOKEN_EXPIRED,
    ErrorCode.REFRESH_TOKEN_REUSED,
    ErrorCode.CSRF_ORIGIN_REJECTED,
    ErrorCode.RATE_LIMITED,
  )
  async refresh(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    try {
      return this.respond(res, await this.auth.refresh(this.readCookie(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw err;
    }
  }

  @Public()
  @UseGuards(CsrfOriginGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE_SCHEME)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes the current session family and clears the cookie. Always succeeds, even without a valid cookie.',
  })
  @ApiNoContentResponse({ description: 'Session revoked, cookie cleared' })
  @ApiErrors(ErrorCode.CSRF_ORIGIN_REJECTED)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.readCookie(req));
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current user',
    description:
      'Profile, active branch memberships and the effective permissions in each branch. Use this to drive navigation and UI visibility.',
  })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update your own profile' })
  @ApiOkResponse({ type: MeDto })
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Post('change-password')
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Re-verifies the current password, revokes **every** session of the account (all devices) and returns a fresh session for this client. Rate-limited per IP.',
  })
  @ApiOkResponse({ type: AuthTokenResponse, headers: SETS_COOKIE })
  @ApiErrors(ErrorCode.INVALID_CURRENT_PASSWORD, ErrorCode.RATE_LIMITED)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    return this.respond(res, await this.auth.changePassword(user.id, dto));
  }

  private respond(res: Response, session: IssuedSession): AuthTokenResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieOptions(),
      expires: session.refreshExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return session.response;
  }

  private readCookie(req: AppRequest): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' ? value : undefined;
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: this.config.get('COOKIE_SAMESITE'),
      path: REFRESH_COOKIE_PATH,
    };
  }
}
