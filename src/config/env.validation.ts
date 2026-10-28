import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? ['1', 'true', 'yes'].includes(value.toLowerCase()) : value;

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  /** zeit/ms style duration, e.g. "15m", "900s". */
  @IsString()
  @Matches(/^\d+(s|m|h)$/, { message: 'JWT_ACCESS_TTL must look like 900s, 15m or 1h' })
  JWT_ACCESS_TTL = '15m';

  @IsString()
  @MinLength(32)
  REFRESH_TOKEN_SECRET!: string;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS = 7;

  @IsString()
  @IsNotEmpty()
  FRONTEND_ORIGIN!: string;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  TRUST_PROXY = 0;

  @Transform(toBool)
  @IsBoolean()
  COOKIE_SECURE = false;

  @IsIn(['strict', 'lax', 'none'])
  COOKIE_SAMESITE: 'strict' | 'lax' | 'none' = 'strict';

  @Transform(toBool)
  @IsBoolean()
  ALLOW_REGISTRATION = true;

  @Transform(toBool)
  @IsBoolean()
  MANAGERS_CAN_MANAGE_PRODUCTS = false;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  AUTH_RATE_LIMIT = 10;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  AUTH_RATE_TTL_SECONDS = 60;

  @Transform(toInt)
  @IsInt()
  @Min(50)
  OUTBOX_POLL_INTERVAL_MS = 1000;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: false });
  const errors = validateSync(env, { skipMissingProperties: false, whitelist: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (env.FRONTEND_ORIGIN.split(',').some((o) => o.trim() === '*')) {
      throw new Error('FRONTEND_ORIGIN must be an explicit allowlist in production');
    }
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }
  return env;
}
