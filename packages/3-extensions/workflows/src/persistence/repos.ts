import { randomUUID } from 'node:crypto';
import type postgres from '@prisma-next/postgres/runtime';
import type { workflowsContract } from './contract';
import { flattenState, hydrateState, type WorkflowState } from './state';

type WorkflowsClient = ReturnType<typeof postgres<typeof workflowsContract>>;
export type WorkflowsOrm = WorkflowsClient['orm'];

// Autoincrement id and defaultSql('now()') fields cannot be inferred as optional in CreateInput
// by TypeScript when using a programmatic (non-emitted) contract. These type aliases are used
// to satisfy the type checker while the DB handles their values at runtime.
type WsfCreateInput = Parameters<WorkflowsOrm['WorkflowStateField']['createCount']>[0];
type WsrCreateInput = Parameters<WorkflowsOrm['WorkflowStepRun']['create']>[0];
type WeCreateInput = Parameters<WorkflowsOrm['WorkflowEvent']['create']>[0];

export interface WorkflowRunRow {
  readonly id: string;
  readonly workflowId: string;
  readonly status: string;
  readonly currentStepId: string | null;
  readonly waitingSignalId: string | null;
  readonly computeServiceId: string | null;
  readonly computeServiceEndpoint: string | null;
  readonly version: number;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface InsertRunInput {
  readonly workflowId: string;
}

export interface UpdateRunStatusOpts {
  readonly waitingSignalId?: string | null;
}

export interface InsertStepRunInput {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
}

export interface AppendEventInput {
  readonly eventType: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly attempt?: number;
  readonly signalId?: string;
  readonly message?: string;
}

export interface WorkflowRepos {
  insertRun(input: InsertRunInput): Promise<string>;
  loadRun(runId: string): Promise<WorkflowRunRow | null>;
  updateRunStatus(runId: string, status: string, opts?: UpdateRunStatusOpts): Promise<void>;
  updateRunCompute(
    runId: string,
    computeServiceId: string,
    computeServiceEndpoint: string,
  ): Promise<void>;
  replaceStateFields(runId: string, state: WorkflowState): Promise<void>;
  loadStateFields(runId: string): Promise<WorkflowState>;
  insertStepRun(input: InsertStepRunInput): Promise<number>;
  markStepCompleted(stepRunId: number): Promise<void>;
  markStepFailed(stepRunId: number, errorMessage: string): Promise<void>;
  loadCompletedStepIds(runId: string): Promise<Set<string>>;
  appendEvent(input: AppendEventInput): Promise<void>;
}

export function createRepos(orm: WorkflowsOrm): WorkflowRepos {
  return {
    async insertRun({ workflowId }) {
      const now = new Date();
      // Provide id explicitly: TypeScript can't infer the execution-default UUID generator
      // as optional in CreateInput for programmatic contracts.
      const row = await orm.WorkflowRun.create({
        id: randomUUID(),
        workflowId,
        status: 'queued',
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
      return row.id;
    },

    async loadRun(runId) {
      return orm.WorkflowRun.where({ id: runId }).first();
    },

    async updateRunStatus(runId, status, opts) {
      if (opts !== undefined && 'waitingSignalId' in opts) {
        await orm.WorkflowRun.where({ id: runId }).updateCount({
          status,
          waitingSignalId: opts.waitingSignalId ?? null,
        });
      } else {
        await orm.WorkflowRun.where({ id: runId }).updateCount({ status });
      }
    },

    async updateRunCompute(runId, computeServiceId, computeServiceEndpoint) {
      await orm.WorkflowRun.where({ id: runId }).updateCount({
        computeServiceId,
        computeServiceEndpoint,
      });
    },

    async replaceStateFields(runId, state) {
      await orm.WorkflowStateField.where({ runId }).deleteCount();
      const fields = flattenState(runId, state);
      if (fields.length > 0) {
        const now = new Date();
        const rows = fields.map((f) => ({ ...f, updatedAt: now }));
        // as unknown as: autoincrement id cannot be inferred as DB-generated for programmatic contracts
        await orm.WorkflowStateField.createCount(rows as unknown as WsfCreateInput);
      }
    },

    async loadStateFields(runId) {
      const rows = await orm.WorkflowStateField.where({ runId }).all().toArray();
      return hydrateState(rows);
    },

    async insertStepRun({ runId, stepId, attempt }) {
      // as unknown as: autoincrement id cannot be inferred as DB-generated for programmatic contracts
      const row = await orm.WorkflowStepRun.create({
        runId,
        stepId,
        attempt,
        status: 'running',
        startedAt: new Date(),
      } as unknown as WsrCreateInput);
      return row.id;
    },

    async markStepCompleted(stepRunId) {
      await orm.WorkflowStepRun.where({ id: stepRunId }).updateCount({
        status: 'completed',
        finishedAt: new Date(),
      });
    },

    async markStepFailed(stepRunId, errorMessage) {
      await orm.WorkflowStepRun.where({ id: stepRunId }).updateCount({
        status: 'failed',
        errorMessage,
        finishedAt: new Date(),
      });
    },

    async loadCompletedStepIds(runId) {
      const ids = new Set<string>();
      for await (const row of orm.WorkflowStepRun.where({ runId, status: 'completed' }).all()) {
        ids.add(row.stepId);
      }
      return ids;
    },

    async appendEvent({ eventType, runId, stepId, attempt, signalId, message }) {
      const now = new Date();
      // as unknown as: autoincrement id and defaultSql('now()') createdAt cannot be inferred as
      // DB-generated for programmatic contracts
      await orm.WorkflowEvent.create({
        eventType,
        runId,
        createdAt: now,
        ...(stepId !== undefined ? { stepId } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
        ...(signalId !== undefined ? { signalId } : {}),
        ...(message !== undefined ? { message } : {}),
      } as unknown as WeCreateInput);
    },
  };
}
