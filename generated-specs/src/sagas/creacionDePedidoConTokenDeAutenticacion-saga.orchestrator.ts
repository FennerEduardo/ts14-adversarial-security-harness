import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler, EventBus } from '@nestjs/cqrs';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreacionDePedidoConTokenDeAutenticacionInitiatedEvent,
  CreacionDePedidoConTokenDeAutenticacionAuthorizedEvent,
  CreacionDePedidoConTokenDeAutenticacionCompletedEvent,
  CreacionDePedidoConTokenDeAutenticacionFailedEvent,
  AuthorizeCreacionDePedidoConTokenDeAutenticacionCommand,
  CompleteCreacionDePedidoConTokenDeAutenticacionCommand,
  CompensateCreacionDePedidoConTokenDeAutenticacionCommand,
} from './creacionDePedidoConTokenDeAutenticacion-saga.contracts';

@Injectable()
export class CreacionDePedidoConTokenDeAutenticacionSagaOrchestrator {
  private readonly logger = new Logger(CreacionDePedidoConTokenDeAutenticacionSagaOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Main entry point for events into the saga.
   * This acts as the state machine transition engine.
   */
  async handleEvent(event: any) {
    if (event instanceof CreacionDePedidoConTokenDeAutenticacionInitiatedEvent) {
      await this.handleInitiated(event);
    } else if (event instanceof CreacionDePedidoConTokenDeAutenticacionAuthorizedEvent) {
      await this.handleAuthorized(event);
    } else if (event instanceof CreacionDePedidoConTokenDeAutenticacionCompletedEvent) {
      await this.handleCompleted(event);
    } else if (event instanceof CreacionDePedidoConTokenDeAutenticacionFailedEvent) {
      await this.handleFailed(event);
    }
  }

  private async handleInitiated(event: CreacionDePedidoConTokenDeAutenticacionInitiatedEvent) {
    this.logger.log(`Saga initiated: ${event.correlationId}`);
    
    // Save initial state to DB
    await this.prisma.sagaInstance.create({
      data: {
        id: event.correlationId,
        sagaType: 'CreacionDePedidoConTokenDeAutenticacion',
        currentState: 'STARTED',
        entityId: event.creacionDePedidoConTokenDeAutenticacionId,
        metadata: JSON.stringify(event.metadata),
      },
    });

    // Dispatch next command via EventBus (or Outbox)
    this.eventBus.publish(new AuthorizeCreacionDePedidoConTokenDeAutenticacionCommand(event.creacionDePedidoConTokenDeAutenticacionId, event.metadata));
  }

  private async handleAuthorized(event: CreacionDePedidoConTokenDeAutenticacionAuthorizedEvent) {
    this.logger.log(`Saga authorized: ${event.correlationId}`);

    const saga = await this.prisma.sagaInstance.findUnique({ where: { id: event.correlationId } });
    if (!saga) throw new Error(`Saga not found: ${event.correlationId}`);

    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'COMPLETING', updatedAt: new Date() },
    });

    this.eventBus.publish(new CompleteCreacionDePedidoConTokenDeAutenticacionCommand(saga.entityId));
  }

  private async handleCompleted(event: CreacionDePedidoConTokenDeAutenticacionCompletedEvent) {
    this.logger.log(`Saga completed: ${event.correlationId}`);
    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'COMPLETED', updatedAt: new Date() },
    });
  }

  private async handleFailed(event: CreacionDePedidoConTokenDeAutenticacionFailedEvent) {
    this.logger.warn(`Saga failed: ${event.correlationId}, reason: ${event.reason}`);
    
    const saga = await this.prisma.sagaInstance.findUnique({ where: { id: event.correlationId } });
    if (!saga) throw new Error(`Saga not found: ${event.correlationId}`);

    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { 
        currentState: 'COMPENSATING', 
        errorReason: event.reason,
        updatedAt: new Date() 
      },
    });

    this.eventBus.publish(new CompensateCreacionDePedidoConTokenDeAutenticacionCommand(saga.entityId, event.reason));
    
    // Once compensation command is sent, we can mark it failed
    await this.prisma.sagaInstance.update({
      where: { id: event.correlationId },
      data: { currentState: 'FAILED', updatedAt: new Date() },
    });
  }
}

// Global Event Handler to route events into the Saga Orchestrator
@EventsHandler(
  CreacionDePedidoConTokenDeAutenticacionInitiatedEvent,
  CreacionDePedidoConTokenDeAutenticacionAuthorizedEvent,
  CreacionDePedidoConTokenDeAutenticacionCompletedEvent,
  CreacionDePedidoConTokenDeAutenticacionFailedEvent,
)
export class CreacionDePedidoConTokenDeAutenticacionSagaEventHandler implements IEventHandler<any> {
  constructor(private readonly orchestrator: CreacionDePedidoConTokenDeAutenticacionSagaOrchestrator) {}

  async handle(event: any) {
    await this.orchestrator.handleEvent(event);
  }
}
