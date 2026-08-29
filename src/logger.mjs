import fs from "node:fs";
import path from "node:path";

export function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = path.join(logDir, "autopilot.log");

  function write(level, message, data = undefined) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(data === undefined ? {} : { data })
    };
    const line = JSON.stringify(entry);
    console.log(line);
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  }

  return {
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data)
  };
}
