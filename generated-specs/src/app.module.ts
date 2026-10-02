import { Module } from '@nestjs/common';
import { ApplicationCqrsModule } from './creacion-de-pedido-con-token-de-autenticacion/creacion-de-pedido-con-token-de-autenticacion.cqrs';

@Module({
  imports: [ApplicationCqrsModule]
})
export class AppModule {}
