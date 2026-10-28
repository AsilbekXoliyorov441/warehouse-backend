import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:._-]{8,128}$/;

export class IdempotentCommandDto {
  @ApiProperty({
    example: 'sale-2f6c1d0e-7b0f-4a52-9d1e-1b0b3c9f1a11',
    description:
      'Client-generated unique key (8-128 chars). Retrying with the same key and payload returns the original result.',
  })
  @IsString()
  @Matches(IDEMPOTENCY_KEY_RE, {
    message: 'idempotencyKey must be 8-128 chars of A-Z a-z 0-9 : . _ -',
  })
  idempotencyKey!: string;
}
