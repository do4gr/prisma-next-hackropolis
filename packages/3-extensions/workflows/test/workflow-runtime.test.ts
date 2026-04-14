import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRepos } from '../src/persistence/repos';
import type { WorkflowDef } from '../src/runtime/execute-workflow';
import { createWorkflowRuntime } from '../src/runtime/workflow-runtime';

function makeRepos(overrides: Partial<WorkflowRepos> = {}): WorkflowRepos {
  return {
    insertRun: vi.fn().mockResolvedValue('run-1'),
    loadRun: vi.fn().mockResolvedValue(null),
    updateRunStatus: vi.fn().mockResolvedValue(undefined),
    updateRunCompute: vi.fn().mockResolvedValue(undefined),
    replaceStateFields: vi.fn().mockResolvedValue(undefined),
    loadStateFields: vi.fn().mockResolvedValue({}),
    insertStepRun: vi.fn().mockResolvedValue(1),
    markStepCompleted: vi.fn().mockResolvedValue(undefined),
    markStepFailed: vi.fn().mockResolvedValue(undefined),
    loadCompletedStepIds: vi.fn().mockResolvedValue(new Set()),
    appendEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createWorkflowRuntime', () => {
  describe('trigger', () => {
    it('inserts a run and returns its id', async () => {
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      const def: WorkflowDef = { workflowId: 'wf-1', steps: [] };
      const runId = await runtime.trigger(def);
      expect(runId).toBe('run-1');
      expect(repos.insertRun).toHaveBeenCalledWith({ workflowId: 'wf-1' });
    });

    it('executes the workflow steps after returning the run id', async () => {
      const execute = vi.fn().mockResolvedValue({});
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      const def: WorkflowDef = {
        workflowId: 'wf-1',
        steps: [{ id: 'step-a', execute }],
      };
      await runtime.trigger(def);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    });

    it('marks the run as completed when all steps finish', async () => {
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      const def: WorkflowDef = { workflowId: 'wf-1', steps: [] };
      await runtime.trigger(def);
      await vi.waitFor(() =>
        expect(repos.updateRunStatus).toHaveBeenCalledWith('run-1', 'completed'),
      );
    });
  });

  describe('signal', () => {
    it('delivers a signal to a waiting workflow step', async () => {
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      const def: WorkflowDef = {
        workflowId: 'wf-1',
        steps: [{ id: 'wait', signalId: 'approval' }],
      };
      await runtime.trigger(def);
      await vi.waitFor(() =>
        expect(repos.updateRunStatus).toHaveBeenCalledWith(
          'run-1',
          'waiting_for_signal',
          expect.objectContaining({ waitingSignalId: 'approval' }),
        ),
      );
      await runtime.signal('run-1', 'approval');
      await vi.waitFor(() =>
        expect(repos.updateRunStatus).toHaveBeenCalledWith('run-1', 'completed'),
      );
    });

    it('marks the signal step as completed after delivery', async () => {
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      const def: WorkflowDef = {
        workflowId: 'wf-1',
        steps: [{ id: 'wait', signalId: 'approval' }],
      };
      await runtime.trigger(def);
      await vi.waitFor(() =>
        expect(repos.updateRunStatus).toHaveBeenCalledWith(
          'run-1',
          'waiting_for_signal',
          expect.anything(),
        ),
      );
      await runtime.signal('run-1', 'approval');
      await vi.waitFor(() => expect(repos.markStepCompleted).toHaveBeenCalledOnce());
    });

    it('throws when no workflow is waiting for the given signal', async () => {
      const repos = makeRepos();
      const runtime = createWorkflowRuntime(repos);
      await expect(runtime.signal('unknown-run', 'approval')).rejects.toThrow(
        /no workflow waiting/i,
      );
    });
  });
});
