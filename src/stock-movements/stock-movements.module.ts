import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { StockLedgerService } from './stock-ledger.service';
import { StockMovementsController } from './stock-movements.controller';
import { StockMovementsService } from './stock-movements.service';

@Module({
  imports: [NotificationsModule],
  controllers: [StockMovementsController],
  providers: [StockLedgerService, StockMovementsService],
  exports: [StockLedgerService],
})
export class StockMovementsModule {}
