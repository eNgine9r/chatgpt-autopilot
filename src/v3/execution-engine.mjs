import { projectById } from './config.mjs';


function normalizeFailure(error) {
  const raw = error?.failure;
  if (raw && typeof raw === 'object') {
    const text = (value, fallback = '') => String(value ?? fallback).slice(0, 160);
    return {
      backend: text(raw.backend, 'executor'),
      category: text(raw.category, 'execution'),
      code: text(raw.code, 'ACTION_FAILED'),
      retryable: raw.retryable === true,
      deviceId: text(raw.deviceId),
      operation: text(raw.operation),
      newAttempt: raw.newAttempt !== false,
    };
  }
  return null;
}

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
      const executionDispatch = {
        ...dispatch,
        taskId: String(result.state.task?.id ?? ''),
        attempt: Number(result.state.attempt ?? 1),
      };
      result = await this.orchestrator.handle({
        id: internalId(event.id, dispatch.stepId, 'start', count),
        projectId: dispatch.projectId,
        kind: 'action.started',
        stepId: dispatch.stepId,
      });
      try {
        const evidence = await this.executor.execute(project, executionDispatch);
        result = await this.orchestrator.handle({
          id: internalId(event.id, dispatch.stepId, 'success', count),
          projectId: dispatch.projectId,
          kind: 'action.succeeded',
          stepId: dispatch.stepId,
          evidence,
        });
      } catch (error) {
        const failure = normalizeFailure(error);
        result = await this.orchestrator.handle({
          id: internalId(event.id, dispatch.stepId, 'failure', count),
          projectId: dispatch.projectId,
          kind: 'action.failed',
          stepId: dispatch.stepId,
          error: failure ? `${failure.backend}:${failure.category}:${failure.code}` : String(error?.message ?? error).slice(0, 4000),
          ...(failure ? { failure } : {}),
        });
        break;
      }
    }
    return { ...result, autoSteps: count };
  }
}
