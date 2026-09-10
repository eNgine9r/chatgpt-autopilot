const ACTIVE = new Set(['ready', 'running', 'waiting_approval', 'blocked', 'paused']);

export function initialState(projectId) {
  return {
    version: 3,
    projectId,
    status: 'idle',
    task: null,
    stepIndex: -1,
    lastError: '',
    lastFailure: null,
    attempt: 1,
    evidence: [],
    recentEventIds: [],
    resumeStatus: '',
    updatedAt: 0,
  };
}

export function currentStep(project, state) {
  return state.stepIndex >= 0 ? project.steps[state.stepIndex] ?? null : null;
}

function remember(state, event) {
  if (!event.id) return state;
  const ids = [...(state.recentEventIds ?? []), String(event.id)].slice(-100);
  return { ...state, recentEventIds: ids };
}

function readyStatus(step) {
  return (step?.approval ?? 'none') === 'user' ? 'waiting_approval' : 'ready';
}

function advance(project, state, event) {
  const evidence = event.evidence
    ? [...state.evidence, String(event.evidence)].slice(-50)
    : state.evidence;
  const nextIndex = state.stepIndex + 1;
  if (nextIndex >= project.steps.length) {
    return { ...state, status: 'complete', stepIndex: nextIndex, evidence, lastError: '', lastFailure: null, attempt: 1 };
  }
  return {
    ...state,
    status: readyStatus(project.steps[nextIndex]),
    stepIndex: nextIndex,
    evidence,
    lastError: '',
    lastFailure: null,
    attempt: 1,
  };
}

export function transition(project, previous, event, now = Date.now()) {
  if (!event || typeof event !== 'object' || !event.kind) throw new Error('invalid_event');
  let state = previous ?? initialState(project.id);
  if (state.projectId !== project.id || state.version !== 3) throw new Error('state_project_mismatch');
  if (event.id && state.recentEventIds?.includes(String(event.id))) return { state, duplicate: true };

  const step = currentStep(project, state);
  const assertStep = () => {
    if (!step || event.stepId !== step.id) throw new Error(`step_mismatch:${step?.id ?? 'none'}`);
  };

  switch (event.kind) {
    case 'task.received': {
      const incomingTaskId = String(event.task?.id ?? event.taskId ?? event.id ?? 'task');
      const currentTaskId = state.task?.id == null ? '' : String(state.task.id);
      if (ACTIVE.has(state.status) && incomingTaskId === currentTaskId) {
        return { state, duplicate: true };
      }
      if (ACTIVE.has(state.status)) throw new Error(`project_busy:${state.status}`);
      state = {
        ...initialState(project.id),
        task: event.task ?? { id: event.taskId ?? String(event.id ?? 'task') },
        stepIndex: 0,
        status: readyStatus(project.steps[0]),
      };
      break;
    }
    case 'action.started':
      if (state.status !== 'ready') throw new Error(`cannot_start:${state.status}`);
      assertStep();
      state = { ...state, status: 'running' };
      break;
    case 'action.succeeded':
      if (state.status !== 'running') throw new Error(`cannot_succeed:${state.status}`);
      assertStep();
      state = advance(project, state, event);
      break;
    case 'action.failed':
      if (state.status !== 'running') throw new Error(`cannot_fail:${state.status}`);
      assertStep();
      state = {
        ...state,
        status: 'blocked',
        lastError: String(event.error ?? 'action_failed'),
        lastFailure: event.failure && typeof event.failure === 'object' ? event.failure : null,
      };
      break;
    case 'approval.granted':
      if (state.status !== 'waiting_approval') throw new Error(`cannot_approve:${state.status}`);
      assertStep();
      state = { ...state, status: 'ready', lastError: '', lastFailure: null };
      break;
    case 'retry':
      if (state.status !== 'blocked') throw new Error(`cannot_retry:${state.status}`);
      state = {
        ...state,
        status: readyStatus(step),
        lastError: '',
        attempt: Number(state.attempt ?? 1) + (state.lastFailure?.newAttempt === false ? 0 : 1),
        lastFailure: null,
      };
      break;
    case 'pause':
      if (!ACTIVE.has(state.status) || state.status === 'paused') throw new Error(`cannot_pause:${state.status}`);
      state = { ...state, resumeStatus: state.status, status: 'paused' };
      break;
    case 'resume':
      if (state.status !== 'paused') throw new Error(`cannot_resume:${state.status}`);
      state = { ...state, status: state.resumeStatus || readyStatus(step), resumeStatus: '' };
      break;
    default:
      throw new Error(`unsupported_event:${event.kind}`);
  }

  state = remember({ ...state, updatedAt: now }, event);
  return { state, duplicate: false };
}
