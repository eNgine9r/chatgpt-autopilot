import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class BrowserlessStatusReader {
  constructor({
    dbFile,
    root = process.cwd(),
    healthUrl = "http://127.0.0.1:8771/health",
    fetchImpl = fetch,
    now = () => Date.now(),
    targetMonthlyUsd = 20,
    hardMonthlyUsd = 30,
    healthTimeoutMs = 1200,
    telemetryTimeoutMs = 2500,
    cacheMs = 10000,
    telemetryImpl = null
  } = {}) {
    this.dbFile = dbFile;
    this.root = root;
    this.healthUrl = healthUrl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.targetMonthlyUsd = Number(targetMonthlyUsd || 20);
    this.hardMonthlyUsd = Number(hardMonthlyUsd || 30);
    this.healthTimeoutMs = healthTimeoutMs;
    this.telemetryTimeoutMs = telemetryTimeoutMs;
    this.cacheMs = cacheMs;
    this.telemetryImpl = telemetryImpl || ((generatedAt) => this.readTelemetry(generatedAt));
    this.cache = null;
  }

  async serviceHealth() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.healthUrl, { signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      return { online: Boolean(response.ok && body.ok), mode: String(body.mode || "browserless"), error: response.ok ? "" : `HTTP_${response.status}` };
    } catch (error) {
      return { online: false, mode: "browserless", error: String(error?.name === "AbortError" ? "health_timeout" : error?.message || error).slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  async readTelemetry(generatedAt) {
    const { stdout } = await execFileAsync("/usr/bin/python3", [
      "-m", "src.browserless.telemetry",
      "--db", this.dbFile,
      "--now-ms", String(generatedAt),
      "--target-monthly-usd", String(this.targetMonthlyUsd),
      "--hard-monthly-usd", String(this.hardMonthlyUsd)
    ], {
      cwd: this.root,
      timeout: this.telemetryTimeoutMs,
      maxBuffer: 256 * 1024,
      env: { ...process.env, PYTHONPATH: this.root }
    });
    return JSON.parse(stdout);
  }

  async status() {
    const generatedAt = this.now();
    const healthPromise = this.serviceHealth();
    let telemetry;
    try {
      if (this.cache && generatedAt - this.cache.at < this.cacheMs) telemetry = this.cache.value;
      else {
        telemetry = await this.telemetryImpl(generatedAt);
        this.cache = { at: generatedAt, value: telemetry };
      }
    } catch (error) {
      telemetry = {
        available: false, mode: "event-driven", model: "gpt-5.6-luna",
        error: String(error?.message || error).slice(0, 180), projects: []
      };
    }
    return { ...telemetry, generatedAt, service: await healthPromise };
  }
}
