import type { WorkflowRepos } from '../persistence/repos';
import { executeWorkflow, type WorkflowDef } from './execute-workflow';

export interface WorkflowRuntime {
  trigger(def: WorkflowDef): Promise<string>;
  signal(runId: string, signalId: string): Promise<void>;
}

export function createWorkflowRuntime(repos: WorkflowRepos): WorkflowRuntime {
  const pendingSignals = new Map<string, () => void>();

  function waitForSignal(runId: string, signalId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      pendingSignals.set(`${runId}:${signalId}`, resolve);
    });
  }

  return {
    async trigger(def) {
      const runId = await repos.insertRun({ workflowId: def.workflowId });
      void executeWorkflow({ runId, def, repos, waitForSignal });
      return runId;
    },

    async signal(runId, signalId) {
      const key = `${runId}:${signalId}`;
      const resolve = pendingSignals.get(key);
      if (resolve === undefined) {
        throw new Error(`No workflow waiting for signal "${signalId}" on run "${runId}"`);
      }
      pendingSignals.delete(key);
      resolve();
    },
  };
}
