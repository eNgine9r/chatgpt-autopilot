import { projectById } from './config.mjs';

function internalId(seed, stepId, phase, n) {
  return `v3:${String(seed || 'event')}:${stepId}:${phase}:${n}`;
}

export class ExecutionEngine {
  constructor(orchestrator, executor, options = {}) {
    this.orchestrator = orchestrator;
    this.executor = executor;
    this.maxAutoSteps = Number(options.maxAutoSteps ?? 16);
  }

  async handle(event) {
    let result = await this.orchestrator.handle(event);
    let count = 0;
    while (result.dispatch) {
      if (++count > this.maxAutoSteps) throw new Error('auto_step_budget_exhausted');
      const dispatch = result.dispatch;
      const project = projectById(this.orchestrator.config, dispatch.projectId);
      result = await this.orchestrator.handle({
        id: internalId(event.id, dispatch.stepId, 'start', count),
        projectId: dispatch.projectId,
        kind: 'action.started',
        stepId: dispatch.stepId,
      });
      try {
        const evidence = await this.executor.execute(project, dispatch);
        result = await this.orchestrator.handle({
          id: internalId(event.id, dispatch.stepId, 'success', count),
          projectId: dispatch.projectId,
          kind: 'action.succeeded',
          stepId: dispatch.stepId,
          evidence,
        });
      } catch (error) {
        result = await this.orchestrator.handle({
          id: internalId(event.id, dispatch.stepId, 'failure', count),
          projectId: dispatch.projectId,
          kind: 'action.failed',
          stepId: dispatch.stepId,
          error: String(error?.message ?? error).slice(0, 4000),
        });
        break;
      }
    }
    return { ...result, autoSteps: count };
  }
}
