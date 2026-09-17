import { operationDefinition } from '../contracts/index.mjs';

export class CommanderAgentOperationDispatcher {
  constructor({ readDispatcher, executionEngine = null, writeDispatcher = null, workSessionManager = null } = {}) {
    if (!readDispatcher) throw new Error('read_dispatcher_required');
    this.readDispatcher = readDispatcher;
    this.executionEngine = executionEngine;
    this.writeDispatcher = writeDispatcher;
    this.workSessionManager = workSessionManager;
  }

  async handle(request) {
    if (request.operation.startsWith('work_session.')) {
      if (!this.workSessionManager) throw new Error('work_session_manager_disabled');
      return this.workSessionManager.handle(request);
    }
    const guarded = await this.workSessionManager?.guardMutation?.(request);
    if (guarded) return guarded;
    const definition = operationDefinition(request.operation);
    let result;
    if (request.operation.startsWith('execution.')) {
      if (!this.executionEngine) throw new Error('execution_engine_disabled');
      result = await this.executionEngine.handle(request);
    } else if (definition.authority === 'write') {
      if (!this.writeDispatcher) throw new Error('controlled_write_disabled');
      result = await this.writeDispatcher.handle(request);
    } else {
      if (definition.authority !== 'read') throw new Error('operation_authority_disabled');
      result = await this.readDispatcher.handle(request);
    }
    await this.workSessionManager?.observeOperation?.(request, result);
    return result;
  }
}
