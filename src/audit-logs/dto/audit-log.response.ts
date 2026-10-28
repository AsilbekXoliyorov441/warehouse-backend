import { ApiProperty } from '@nestjs/swagger';

class AuditUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
  @ApiProperty({ format: 'email' }) email!: string;
}

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) userId!: string | null;
  @ApiProperty({ example: 'inventory.sale' }) action!: string;
  @ApiProperty({ example: 'StockMovement' }) entityType!: string;
  @ApiProperty() entityId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Action-specific context. Credentials are always stripped.',
    example: { branchId: '…', quantity: 3, previousQuantity: 20, newQuantity: 17 },
  })
  metadata!: Record<string, unknown>;

  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: AuditUserDto, nullable: true }) user!: AuditUserDto | null;
}
