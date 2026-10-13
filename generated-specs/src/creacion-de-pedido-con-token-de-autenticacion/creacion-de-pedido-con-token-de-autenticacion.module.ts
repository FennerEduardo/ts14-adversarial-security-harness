import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { CommandService } from '../runtime/command-service';
import { PG_POOL } from '../runtime/runtime.module';
import { CreacionDePedidoConTokenDeAutenticacionController } from './creacion-de-pedido-con-token-de-autenticacion.controller';

@Module({
  controllers: [CreacionDePedidoConTokenDeAutenticacionController],
  providers: [{ provide: CommandService, useFactory: (pool: Pool) => new CommandService(pool), inject: [PG_POOL] }]
})
export class CreacionDePedidoConTokenDeAutenticacionModule {}
