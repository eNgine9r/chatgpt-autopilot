import { currentStep, transition } from './state-machine.mjs';
import { projectById } from './config.mjs';

export class Orchestrator {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  async handle(event) {
    const project = projectById(this.config, event.projectId);
    const previous = await this.store.load(project.id);
    const result = transition(project, previous, event);
    if (!result.duplicate) await this.store.save(project.id, result.state);

    const step = currentStep(project, result.state);
    const dispatch = result.state.status === 'ready' && step
      ? {
          projectId: project.id,
          stepId: step.id,
          action: step.action,
          params: step.params ?? {},
        }
      : null;
    return { ...result, dispatch };
  }
}
