import fs from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { JsonStateStore } from './store.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { DeterministicExecutor } from './executor.mjs';
import { ExecutionEngine } from './execution-engine.mjs';
import { createControlServer, createGitHubServer } from './http-servers.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const configPath = arg('--config', process.env.AUTOPILOT_V3_CONFIG ?? 'config/v3-projects.json');
const stateDir = arg('--state-dir', process.env.AUTOPILOT_V3_STATE_DIR ?? 'state-v3');
const secretFile = arg('--github-secret-file', process.env.AUTOPILOT_V3_GITHUB_SECRET_FILE ?? '');
const host = '127.0.0.1';
const controlPort = Number(arg('--port', process.env.AUTOPILOT_V3_PORT ?? '8780'));
const githubPort = Number(arg('--github-port', process.env.AUTOPILOT_V3_GITHUB_PORT ?? '8781'));

async function loadWebhookSecret(filePath) {
  if (!filePath) return '';
  const secret = (await fs.readFile(filePath, 'utf8')).trim();
  if (secret.length < 32 || secret.length > 256) throw new Error('invalid_github_webhook_secret');
  return secret;
}

const config = await loadConfig(configPath);

const webhookSecret = await loadWebhookSecret(secretFile);
const store = new JsonStateStore(stateDir);
await store.init();
const orchestrator = new Orchestrator(config, store);
const engine = new ExecutionEngine(orchestrator, new DeterministicExecutor());
const controlServer = createControlServer({
  store,
  engine,
  githubWebhook: Boolean(webhookSecret),
});
const githubServer = createGitHubServer({ config, engine, webhookSecret });

controlServer.listen(controlPort, host, () => {
  console.log(`autopilot-v3 control listening http://${host}:${controlPort}`);
});

if (githubServer) {
  githubServer.listen(githubPort, host, () => {
    console.log(`autopilot-v3 github listening http://${host}:${githubPort}`);
  });
}
