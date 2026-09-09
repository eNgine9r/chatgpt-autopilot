import { operationDefinition } from '../contracts/index.mjs';

export class CommanderAgentOperationDispatcher {
  constructor({ readDispatcher, executionEngine = null } = {}) {
    if (!readDispatcher) throw new Error('read_dispatcher_required');
    this.readDispatcher = readDispatcher;
    this.executionEngine = executionEngine;
  }

  async handle(request) {
    const definition = operationDefinition(request.operation);
    if (request.operation.startsWith('execution.')) {
      if (!this.executionEngine) throw new Error('execution_engine_disabled');
      return this.executionEngine.handle(request);
    }
    if (definition.authority !== 'read') throw new Error('operation_authority_disabled');
    return this.readDispatcher.handle(request);
  }
}
