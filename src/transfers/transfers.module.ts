import { Module } from '@nestjs/common';
import { StockMovementsModule } from '../stock-movements/stock-movements.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [StockMovementsModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
