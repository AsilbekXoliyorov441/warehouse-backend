import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { toLowerTrim, trim } from '../../common/utils/transform';
import { CreateUserDto, PASSWORD_MESSAGE, PASSWORD_RULE } from '../../users/dto/create-user.dto';

export class RegisterDto extends CreateUserDto {}

export class LoginDto {
  @ApiProperty({ example: 'admin@stockpulse.dev' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Admin12345!' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'Admin12345!' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ example: 'NewSecret2026', minLength: 10, maxLength: 128 })
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiProperty({ example: 'Jane Doe' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class AuthUserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
  @ApiProperty({ format: 'email', example: 'jane@example.com' }) email!: string;
}

export class AuthTokenResponse {
  @ApiProperty({ description: 'Short-lived JWT. Send as "Authorization: Bearer <token>".' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Access token lifetime in seconds', example: 900 })
  expiresIn!: number;

  @ApiProperty({ type: AuthUserResponse })
  user!: AuthUserResponse;
}
