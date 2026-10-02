import { CreacionDePedidoConTokenDeAutenticacionAggregate, DomainValidationError } from './creacion-de-pedido-con-token-de-autenticacion.aggregate';

describe('CreacionDePedidoConTokenDeAutenticacionAggregate', () => {
  it('starts in the initial state with no events', () => {
    const aggregate = new CreacionDePedidoConTokenDeAutenticacionAggregate('agg-1');
    expect(aggregate.state).toBe('PENDING');
    expect(aggregate.version).toBe(0);
    expect(aggregate.pendingEvents).toHaveLength(0);
  });

  it('rejects an aggregate without id', () => {
    expect(() => new CreacionDePedidoConTokenDeAutenticacionAggregate('')).toThrow(DomainValidationError);
  });

  it('processCreacionDePedidoConTokenDeAutenticacion records ProcessCreacionDePedidoConTokenDeAutenticacionCompleted and bumps the version', () => {
    const aggregate = new CreacionDePedidoConTokenDeAutenticacionAggregate('agg-1');
    const event = aggregate.processCreacionDePedidoConTokenDeAutenticacion({ id: 'agg-1', payload: { source: 'test' } });
    expect(event.type).toBe('ProcessCreacionDePedidoConTokenDeAutenticacionCompleted');
    expect(event.version).toBe(1);
    expect(aggregate.version).toBe(1);
    expect(aggregate.pendingEvents).toEqual([event]);
  });

  it('processCreacionDePedidoConTokenDeAutenticacion rejects a command without id', () => {
    const aggregate = new CreacionDePedidoConTokenDeAutenticacionAggregate('agg-1');
    expect(() => aggregate.processCreacionDePedidoConTokenDeAutenticacion({ id: '' })).toThrow(DomainValidationError);
    expect(aggregate.pendingEvents).toHaveLength(0);
  });
});
