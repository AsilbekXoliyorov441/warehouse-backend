import { Module } from '@nestjs/common';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [StockMovementsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
