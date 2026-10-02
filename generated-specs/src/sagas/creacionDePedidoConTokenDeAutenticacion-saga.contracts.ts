// --------------------------------------------------------------------------
// Saga Contracts for CreacionDePedidoConTokenDeAutenticacion
// --------------------------------------------------------------------------

// === Events ===
export class CreacionDePedidoConTokenDeAutenticacionInitiatedEvent {
  constructor(public readonly correlationId: string, public readonly creacionDePedidoConTokenDeAutenticacionId: string, public readonly metadata: any) {}
}
export class CreacionDePedidoConTokenDeAutenticacionAuthorizedEvent {
  constructor(public readonly correlationId: string) {}
}
export class CreacionDePedidoConTokenDeAutenticacionCompletedEvent {
  constructor(public readonly correlationId: string) {}
}
export class CreacionDePedidoConTokenDeAutenticacionFailedEvent {
  constructor(public readonly correlationId: string, public readonly reason: string) {}
}

// === Commands ===
export class AuthorizeCreacionDePedidoConTokenDeAutenticacionCommand {
  constructor(public readonly creacionDePedidoConTokenDeAutenticacionId: string, public readonly metadata: any) {}
}
export class CompleteCreacionDePedidoConTokenDeAutenticacionCommand {
  constructor(public readonly creacionDePedidoConTokenDeAutenticacionId: string) {}
}
export class CompensateCreacionDePedidoConTokenDeAutenticacionCommand {
  constructor(public readonly creacionDePedidoConTokenDeAutenticacionId: string, public readonly reason: string) {}
}
