import type { Pool } from 'pg';
import { schemaName } from './schema';

export interface SagaStep {
  name: string;
  action: () => Promise<void>;
  compensate: () => Promise<void>;
}

export type SagaStatus = 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED';

/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed
 * steps are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
export class SagaOrchestrator {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = 'public') {
    this.s = schemaName(schema);
  }

  async run(sagaId: string, tenantId: string, steps: SagaStep[]): Promise<SagaStatus> {
    await this.pool.query(`INSERT INTO ${this.s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING`, [sagaId, tenantId]);
    const { rows } = await this.pool.query(`SELECT completed_steps FROM ${this.s}.ghk_sagas WHERE id = $1 AND tenant_id = $2`, [sagaId, tenantId]);
    const completed: string[] = rows[0]?.completed_steps ? String(rows[0].completed_steps).split(',') : [];
    for (const step of steps) {
      if (completed.includes(step.name)) continue;
      try {
        await step.action();
        completed.push(step.name);
        await this.save(sagaId, 'RUNNING', completed);
      } catch {
        await this.save(sagaId, 'COMPENSATING', completed);
        for (const name of [...completed].reverse()) {
          await steps.find(s => s.name === name)!.compensate();
          completed.splice(completed.indexOf(name), 1);
          await this.save(sagaId, 'COMPENSATING', completed);
        }
        await this.save(sagaId, 'COMPENSATED', completed);
        return 'COMPENSATED';
      }
    }
    await this.save(sagaId, 'COMPLETED', completed);
    return 'COMPLETED';
  }

  async status(sagaId: string): Promise<{ status: SagaStatus; completedSteps: string[] } | undefined> {
    const { rows } = await this.pool.query(`SELECT status, completed_steps FROM ${this.s}.ghk_sagas WHERE id = $1`, [sagaId]);
    return rows[0] ? { status: rows[0].status, completedSteps: rows[0].completed_steps ? String(rows[0].completed_steps).split(',') : [] } : undefined;
  }

  private async save(sagaId: string, status: SagaStatus, completed: string[]): Promise<void> {
    await this.pool.query(`UPDATE ${this.s}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1`, [sagaId, status, completed.join(',')]);
  }
}
