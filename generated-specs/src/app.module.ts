import { Module } from '@nestjs/common';
import { RuntimeModule } from './runtime/runtime.module';
import { CreacionDePedidoConTokenDeAutenticacionModule } from './creacion-de-pedido-con-token-de-autenticacion/creacion-de-pedido-con-token-de-autenticacion.module';

@Module({
  imports: [RuntimeModule, CreacionDePedidoConTokenDeAutenticacionModule]
})
export class AppModule {}
