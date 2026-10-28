import { Module } from '@nestjs/common';
import { InventoryGateway } from './inventory.gateway';
import { OutboxDispatcherService } from './outbox/outbox-dispatcher.service';

/** Socket.IO gateway and the outbox worker that feeds it. Depends on Auth/Users/BranchAccess (global). */
@Module({
  providers: [InventoryGateway, OutboxDispatcherService],
  exports: [OutboxDispatcherService],
})
export class RealtimeModule {}
