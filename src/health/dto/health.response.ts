import { ApiProperty } from '@nestjs/swagger';

export class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] }) status!: 'ok' | 'degraded';
  @ApiProperty({ enum: ['up', 'down'] }) database!: 'up' | 'down';
  @ApiProperty({ example: 3600 }) uptimeSeconds!: number;
  @ApiProperty() timestamp!: string;
}
