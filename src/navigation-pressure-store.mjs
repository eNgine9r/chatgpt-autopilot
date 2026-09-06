import fs from "node:fs";
import path from "node:path";

function normalizeState(value = {}) {
  return {
    lastNavigationAt: Math.max(0, Number(value.lastNavigationAt || 0)),
    backoffUntil: Math.max(0, Number(value.backoffUntil || 0)),
    lastRateLimitAt: Math.max(0, Number(value.lastRateLimitAt || 0))
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class NavigationPressureStore {
  constructor({ file, rateLimitBackoffMs = 600000, minNavigationGapMs = 90000, lockRetryMs = 10, lockRetries = 100 } = {}) {
    if (!file) throw new Error("navigation_pressure_file_required");
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
    this.rateLimitBackoffMs = Math.max(60000, Number(rateLimitBackoffMs || 600000));
    this.minNavigationGapMs = Math.max(30000, Number(minNavigationGapMs || 90000));
    this.lockRetryMs = Math.max(1, Number(lockRetryMs || 10));
    this.lockRetries = Math.max(1, Number(lockRetries || 100));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  snapshot() {
    try { return normalizeState(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
    catch (error) {
      if (error?.code === "ENOENT") return normalizeState();
      throw error;
    }
  }

  async withLock(mutator) {
    let lockFd = null;
    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      try { lockFd = fs.openSync(this.lockFile, "wx", 0o600); break; }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await sleep(this.lockRetryMs);
      }
    }
    if (lockFd === null) throw new Error("navigation_pressure_lock_timeout");
    try {
      const current = this.snapshot();
      const next = normalizeState(await mutator(current));
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return next;
    } finally {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(this.lockFile); } catch {}
    }
  }

  async claimNavigation(now = Date.now()) {
    const observed = Number(now);
    let allowed = false;
    const state = await this.withLock((current) => {
      const blockedByRateLimit = current.backoffUntil > observed;
      const blockedByGap = current.lastNavigationAt > 0
        && observed - current.lastNavigationAt < this.minNavigationGapMs;
      if (blockedByRateLimit || blockedByGap) return current;
      allowed = true;
      return { ...current, lastNavigationAt: Math.max(current.lastNavigationAt, observed) };
    });
    return { allowed, ...state };
  }

  recordRateLimit(now = Date.now()) {
    const observed = Number(now);
    return this.withLock((state) => ({
      ...state,
      lastRateLimitAt: Math.max(state.lastRateLimitAt, observed),
      backoffUntil: Math.max(state.backoffUntil, observed + this.rateLimitBackoffMs)
    }));
  }
}
