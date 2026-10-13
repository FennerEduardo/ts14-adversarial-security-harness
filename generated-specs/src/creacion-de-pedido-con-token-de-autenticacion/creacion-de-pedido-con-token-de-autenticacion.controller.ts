import { Body, Controller, Headers, HttpException, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { CommandService } from '../runtime/command-service';
import { DomainValidationError } from './domain/creacion-de-pedido-con-token-de-autenticacion.aggregate';
import { JwtTenantGuard } from '../auth/jwt-tenant.guard';

const STATUS = { created: HttpStatus.ACCEPTED, replayed: HttpStatus.OK, 'in-progress': HttpStatus.CONFLICT } as const;

// ghk:implements CreacionDePedidoConTokenDeAutenticacion
@Controller('api/v1/creacion-de-pedido-con-token-de-autenticacion')
@UseGuards(JwtTenantGuard)
export class CreacionDePedidoConTokenDeAutenticacionController {
  constructor(@Inject(CommandService) private readonly commands: CommandService) {}

  /** POST /api/v1/creacion-de-pedido-con-token-de-autenticacion/:id/:command (process_creacion_de_pedido_con_token_de_autenticacion) */
  @Post(':id/:command')
  async handle(
    @Param('id') id: string,
    @Param('command') command: string,
    @Body() payload: Record<string, unknown> | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('traceparent') traceparent: string | undefined,
    @Req() req: { tenantId: string },
    @Res({ passthrough: true }) res: { status(code: number): unknown }
  ) {
    try {
      const result = await this.commands.handle({ tenantId: req.tenantId, aggregateType: 'CreacionDePedidoConTokenDeAutenticacion', aggregateId: id, command, payload: payload ?? {}, idempotencyKey, traceparent });
      res.status(STATUS[result.status]);
      return result;
    } catch (err) {
      // By name: every feature's domain module declares its own DomainValidationError class.
      if (err instanceof DomainValidationError || (err as Error)?.name === 'DomainValidationError') throw new HttpException((err as Error).message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw err;
    }
  }
}
