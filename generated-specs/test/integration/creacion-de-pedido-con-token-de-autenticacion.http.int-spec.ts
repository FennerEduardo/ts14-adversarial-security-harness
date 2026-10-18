// HTTP contract of the application layer (POST /api/v1/creacion-de-pedido-con-token-de-autenticacion/:id/:command) against PostgreSQL.
// Requires DATABASE_URL (and AMQP_URL for the relay worker). Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { migrate } from '../../src/runtime/schema';
import { signJwt, TENANT_CLAIM } from '../../src/auth/jwt';

const SECRET = 'integration-test-secret-with-32-chars!';
process.env.JWT_SECRET = SECRET;

describe('CreacionDePedidoConTokenDeAutenticacion HTTP application layer', () => {
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  const tenant = `tenant-${randomUUID()}`;
  const token = (claims: Record<string, unknown>) => `Bearer ${signJwt(claims, SECRET)}`;
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(pool);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('rejects requests without a valid token, and never trusts X-Tenant-Id', async () => {
    const id = randomUUID();
    expect((await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, {})).status).toBe(401);
    expect((await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, { 'x-tenant-id': tenant })).status).toBe(401);
    expect((await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, { authorization: token({ sub: 'u1' }) })).status).toBe(401);
    expect((await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, { authorization: `Bearer ${signJwt({ [TENANT_CLAIM]: tenant }, 'wrong-secret')}` })).status).toBe(401);
  });

  it('runs a command into the outbox for the token tenant, idempotently', async () => {
    const id = randomUUID();
    const headers = { authorization: token({ [TENANT_CLAIM]: tenant }), 'idempotency-key': randomUUID(), 'x-tenant-id': 'someone-else' };
    const first = await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, headers);
    expect(first.status).toBe(202);
    const replay = await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${id}/process_creacion_de_pedido_con_token_de_autenticacion`, headers);
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe('replayed');

    const { rows } = await pool.query('SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1', [id]);
    expect(rows).toEqual([{ tenant_id: tenant }]);
  });

  it('maps domain validation errors to 422', async () => {
    const res = await post(`/api/v1/creacion-de-pedido-con-token-de-autenticacion/${randomUUID()}/no_such_command`, { authorization: token({ [TENANT_CLAIM]: tenant }) });
    expect(res.status).toBe(422);
  });

  it('reports liveness and database readiness without a token', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });
});
