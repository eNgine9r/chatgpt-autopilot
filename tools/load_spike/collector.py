#!/usr/bin/env python3
"""Bounded, unprivileged Raspberry Pi load-spike evidence collector.

Reads only aggregate /proc statistics and *metadata* of processes. Never reads
command lines, environments, logs, files, browser data or secrets.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import time
from datetime import datetime, timezone
from pathlib import Path

INTERVAL = 15.0
THRESHOLD = 3.0
MAX_BYTES = 10 * 1024 * 1024
RETENTION_SECONDS = 48 * 3600
SERVICE_NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,100}\.(?:service|scope)$")
SAFE_COMM_RE = re.compile(r"[^A-Za-z0-9_.@ +:-]")


def read_text(path: Path, limit: int = 16384) -> str:
    with path.open("r", encoding="utf-8", errors="replace") as file:
        return file.read(limit)


def parse_stat(raw: str) -> dict:
    """Linux proc stat is PID (comm with spaces/parentheses) state ..."""
    left = raw.index("(")
    right = raw.rindex(")")
    pid = int(raw[:left].strip())
    comm = SAFE_COMM_RE.sub("_", raw[left + 1:right]).strip()[:64]
    f = raw[right + 1:].split()  # f[0] is kernel field 3
    return {"pid": pid, "ppid": int(f[1]), "comm": comm,
            "state": f[0][:1], "cpu_ticks": int(f[11]) + int(f[12]),
            "start_ticks": int(f[19]), "rss_pages": max(0, int(f[21]))}


def systemd_unit(raw: str) -> str | None:
    """Return *only* a sanitized systemd unit basename, never a cgroup path."""
    for entry in raw.splitlines():
        path = entry.rsplit(":", 1)[-1]
        for segment in reversed(path.split("/")):
            if SERVICE_NAME_RE.fullmatch(segment):
                return segment
    return None


def psi(raw: str) -> dict:
    result = {}
    for line in raw.splitlines():
        parts = line.split()
        if not parts or parts[0] not in ("some", "full"):
            continue
        values = {}
        for item in parts[1:]:
            if "=" not in item:
                continue
            key, value = item.split("=", 1)
            if key in ("avg10", "avg60", "avg300"):
                try:
                    values[key] = float(value)
                except ValueError:
                    pass
        result[parts[0]] = values
    return result


def mem_info(raw: str) -> dict:
    keys = {"MemAvailable", "MemTotal", "SwapTotal", "SwapFree"}
    result = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        if key in keys:
            try:
                result[key + "KiB"] = int(value.split()[0])
            except (ValueError, IndexError):
                pass
    return result


def cpu_info(proc_root: Path) -> dict:
    out = {}
    for kind in ("cpu", "memory", "io"):
        try:
            out[kind] = psi(read_text(proc_root / "pressure" / kind))
        except (OSError, ValueError):
            out[kind] = None
    return out


def process_snapshot(proc_root: Path, page_size: int) -> dict:
    procs = {}
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return procs
    for d in entries:
        if not d.name.isdecimal() or not d.is_dir():
            continue
        try:
            p = parse_stat(read_text(d / "stat", 4096))
            p["rssKiB"] = p.pop("rss_pages") * page_size // 1024
            try:
                p["service"] = systemd_unit(read_text(d / "cgroup", 4096))
            except OSError:
                p["service"] = None
            procs[(p["pid"], p["start_ticks"])] = p
        except (OSError, ValueError, IndexError):
            continue  # raced with process exit / proc permissions
    return procs


def top_processes(previous: dict, current: dict, seconds: float, ticks: int) -> dict:
    rows = []
    blocked = []
    for key, p in current.items():
        prev = previous.get(key)
        delta = max(0, p["cpu_ticks"] - prev["cpu_ticks"]) if prev else 0
        row = {"pid": p["pid"], "ppid": p["ppid"], "comm": p["comm"],
               "state": p["state"], "service": p["service"],
               "rssKiB": p["rssKiB"],
               "cpuPct": round(delta * 100.0 / max(seconds * ticks, 1), 1)}
        rows.append(row)
        if p["state"] == "D":
            blocked.append(row)
    return {"topCpu": sorted(rows, key=lambda r: (r["cpuPct"], r["rssKiB"]), reverse=True)[:10],
            "topMemory": sorted(rows, key=lambda r: r["rssKiB"], reverse=True)[:10],
            "diskSleepCount": len(blocked),
            "diskSleep": sorted(blocked, key=lambda r: r["rssKiB"], reverse=True)[:10]}


def current_load(proc_root: Path) -> tuple[float, float, float]:
    nums = read_text(proc_root / "loadavg", 256).split()
    return tuple(float(x) for x in nums[:3])


def capture(proc_root: Path, old: dict, new: dict, duration: float,
            load: tuple[float, float, float], ticks: int) -> dict:
    try:
        memory = mem_info(read_text(proc_root / "meminfo", 8192))
    except OSError:
        memory = {}
    return {"schemaVersion": 1,
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "load1": load[0], "load5": load[1], "load15": load[2],
            "durationSeconds": round(duration, 1), "memory": memory,
            "pressure": cpu_info(proc_root),
            **top_processes(old, new, duration, ticks)}


def prune(state_dir: Path, now: float, max_bytes: int = MAX_BYTES,
          age_seconds: int = RETENTION_SECONDS) -> None:
    files = []
    for path in state_dir.glob("spike-*.json"):
        try:
            st = path.stat()
        except OSError:
            continue
        if now - st.st_mtime > age_seconds:
            path.unlink(missing_ok=True)
        else:
            files.append((st.st_mtime, st.st_size, path))
    files.sort(key=lambda x: x[0])
    total = sum(n for _, n, _ in files)
    while total > max_bytes and files:
        _, size, path = files.pop(0)
        path.unlink(missing_ok=True)
        total -= size


def save_event(state_dir: Path, reason: str, record: dict, *, now: float | None = None) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.chmod(0o700)
    stamp = time.time() if now is None else now
    # Millisecond timestamp + PID plus exclusive create avoids collisions.
    name = f"spike-{int(stamp * 1000)}-{os.getpid()}.json"
    target = state_dir / name
    payload = {"reason": reason, **record}
    encoded = (json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise ValueError("diagnostic record exceeds storage budget")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(encoded)
    prune(state_dir, stamp)
    return target


def run(args: argparse.Namespace) -> int:
    if args.interval < 5 or args.interval > 600:
        raise ValueError("interval must be between 5 and 600 seconds")
    if args.threshold < 0 or args.threshold > 1000:
        raise ValueError("invalid threshold")
    proc_root = Path(args.proc_root)
    state_dir = Path(args.state_dir).expanduser()
    ticks = os.sysconf("SC_CLK_TCK")
    page_size = os.sysconf("SC_PAGE_SIZE")
    stopping = False

    def stop(*_unused: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    old = process_snapshot(proc_root, page_size)
    last_t = time.monotonic()
    over_count = 0
    active = False
    last_emitted = 0.0
    while not stopping:
        if args.once:
            # Tests / one-off diagnostics: no sleeping and no accidental persistence.
            return 0
        time.sleep(args.interval)
        now_t = time.monotonic()
        try:
            load = current_load(proc_root)
            new = process_snapshot(proc_root, page_size)
        except (OSError, ValueError):
            continue
        duration = max(now_t - last_t, 0.001)
        if load[0] >= args.threshold:
            over_count += 1
        else:
            over_count = 0
        reason = None
        if not active and over_count >= 2:
            active = True
            reason = "spike_start"
        elif active and load[0] <= args.threshold * 0.75:
            active = False
            reason = "recovered"
        elif active and now_t - last_emitted >= 120:
            reason = "spike_sustained"
        if reason:
            try:
                sample = capture(proc_root, old, new, duration, load, ticks)
                save_event(state_dir, reason, sample)
                last_emitted = now_t
            except (OSError, ValueError):
                # Collector must never affect main services on I/O failures.
                pass
        old, last_t = new, now_t
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--interval", type=float, default=INTERVAL)
    p.add_argument("--threshold", type=float, default=THRESHOLD)
    p.add_argument("--proc-root", default="/proc", help=argparse.SUPPRESS)
    p.add_argument("--state-dir", default=str(Path.home() / ".local/state/nexus-load-spike"))
    p.add_argument("--once", action="store_true", help="read-only startup check")
    return run(p.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
