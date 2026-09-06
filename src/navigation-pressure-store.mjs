import fs from "node:fs";
import path from "node:path";

function normalizeState(value = {}) {
  return {
    lastNavigationAt: Math.max(0, Number(value.lastNavigationAt || 0)),
    backoffUntil: Math.max(0, Number(value.backoffUntil || 0)),
    lastRateLimitAt: Math.max(0, Number(value.lastRateLimitAt || 0)),
    rateLimitStrikes: Math.max(0, Math.floor(Number(value.rateLimitStrikes || 0)))
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class NavigationPressureStore {
  constructor({ file, rateLimitBackoffMs = 900000, rateLimitBackoffScheduleMs = null,
    rateLimitCleanWindowMs = 6 * 60 * 60 * 1000, minNavigationGapMs = 90000,
    lockRetryMs = 10, lockRetries = 100 } = {}) {
    if (!file) throw new Error("navigation_pressure_file_required");
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
    const base = Math.max(60000, Number(rateLimitBackoffMs || 900000));
    const rawSchedule = Array.isArray(rateLimitBackoffScheduleMs) && rateLimitBackoffScheduleMs.length
      ? rateLimitBackoffScheduleMs
      : [base, base * 2, base * 4, base * 8];
    this.rateLimitBackoffScheduleMs = rawSchedule.map((value) => Math.max(60000, Number(value || base)));
    this.rateLimitCleanWindowMs = Math.max(5 * 60 * 1000, Number(rateLimitCleanWindowMs || 6 * 60 * 60 * 1000));
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

  decayStrikes(state, observed) {
    if (!state.lastRateLimitAt || observed - state.lastRateLimitAt < this.rateLimitCleanWindowMs) return state;
    return { ...state, rateLimitStrikes: 0 };
  }

  async claimNavigation(now = Date.now()) {
    const observed = Number(now);
    let allowed = false;
    const state = await this.withLock((current) => {
      const decayed = this.decayStrikes(current, observed);
      const blockedByRateLimit = decayed.backoffUntil > observed;
      const blockedByGap = decayed.lastNavigationAt > 0
        && observed - decayed.lastNavigationAt < this.minNavigationGapMs;
      if (blockedByRateLimit || blockedByGap) return decayed;
      allowed = true;
      return { ...decayed, lastNavigationAt: Math.max(decayed.lastNavigationAt, observed) };
    });
    return { allowed, ...state };
  }

  recordRateLimit(now = Date.now()) {
    const observed = Number(now);
    return this.withLock((current) => {
      const decayed = this.decayStrikes(current, observed);
      if (decayed.backoffUntil > observed && decayed.rateLimitStrikes > 0) {
        return { ...decayed, lastRateLimitAt: Math.max(decayed.lastRateLimitAt, observed) };
      }
      const strikes = Math.min(decayed.rateLimitStrikes + 1, this.rateLimitBackoffScheduleMs.length);
      const duration = this.rateLimitBackoffScheduleMs[Math.max(0, strikes - 1)];
      return {
        ...decayed,
        rateLimitStrikes: strikes,
        lastRateLimitAt: Math.max(decayed.lastRateLimitAt, observed),
        backoffUntil: Math.max(decayed.backoffUntil, observed + duration)
      };
    });
  }
}
