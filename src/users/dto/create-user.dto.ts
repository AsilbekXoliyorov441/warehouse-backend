import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { toLowerTrim, trim } from '../../common/utils/transform';

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
export const PASSWORD_MESSAGE =
  'password must be 10-128 characters and contain at least one letter and one digit';

export class CreateUserDto {
  @ApiProperty({ example: 'Jane Doe' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'jane@example.com' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'CorrectHorse42', minLength: 10 })
  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;
}
