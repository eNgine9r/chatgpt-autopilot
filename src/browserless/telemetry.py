import argparse
import calendar
import json
import sqlite3
import time
from pathlib import Path


def _num(value):
    return 0 if value is None else value


def _json(value):
    try:
        return json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}


def _usage(con, since, project_id=None):
    params = [since]
    where = "created_at>=?"
    if project_id:
        where += " AND project_id=?"
        params.append(project_id)
    row = con.execute(f"""SELECT COUNT(*) calls,
        COALESCE(SUM(input_tokens),0) input_tokens,
        COALESCE(SUM(cached_input_tokens),0) cached_input_tokens,
        COALESCE(SUM(output_tokens),0) output_tokens,
        COALESCE(SUM(cost_usd),0) cost_usd FROM usage WHERE {where}""", params).fetchone()
    return {"calls": int(row["calls"]), "inputTokens": int(row["input_tokens"]),
            "cachedInputTokens": int(row["cached_input_tokens"]), "outputTokens": int(row["output_tokens"]),
            "costUsd": float(row["cost_usd"])}


def _count(con, table, status):
    return int(con.execute(f"SELECT COUNT(*) n FROM {table} WHERE status=?", (status,)).fetchone()["n"])


def _project(con, row, month_start):
    cp = _json(row["checkpoint_json"])
    latest = con.execute("SELECT status,last_error,decision_json,updated_at FROM jobs WHERE project_id=? ORDER BY id DESC LIMIT 1", (row["id"],)).fetchone()
    decision = _json(latest["decision_json"]).get("decision", "") if latest else ""
    jobs = {status: int(con.execute("SELECT COUNT(*) n FROM jobs WHERE project_id=? AND status=?", (row["id"], status)).fetchone()["n"])
            for status in ("pending", "running", "blocked")}
    return {"id": row["id"], "planVersion": row["plan_version"], "updatedAt": int(row["updated_at"]) * 1000,
            "checkpoint": {"stage": str(cp.get("stage") or cp.get("completionStatus") or "active"),
                           "goal": str(cp.get("goal") or ""), "currentTask": str(cp.get("currentTask") or ""),
                           "nextAction": str(cp.get("nextAction") or ""),
                           "blockers": [str(x) for x in cp.get("blockers", [])] if isinstance(cp.get("blockers", []), list) else []},
            "usageMonth": _usage(con, month_start, row["id"]), "jobs": jobs,
            "latestJob": None if latest is None else {"status": str(latest["status"] or ""), "decision": str(decision),
                "lastError": str(latest["last_error"] or ""), "updatedAt": int(latest["updated_at"]) * 1000}}


def snapshot(db_path, now_ms=None, target_monthly_usd=20.0, hard_monthly_usd=30.0):
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    now = time.gmtime(now_ms / 1000)
    day_start = calendar.timegm((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, 0))
    month_start = calendar.timegm((now.tm_year, now.tm_mon, 1, 0, 0, 0, 0, 0, 0))
    uri = f"file:{Path(db_path).resolve()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        today = _usage(con, day_start)
        month = _usage(con, month_start)
        model_row = con.execute("SELECT model FROM usage ORDER BY id DESC LIMIT 1").fetchone()
        projects = [_project(con, row, month_start) for row in con.execute("SELECT id,plan_version,checkpoint_json,updated_at FROM projects ORDER BY id")]
        events_today = int(con.execute("SELECT COUNT(*) n FROM events WHERE created_at>=?", (day_start,)).fetchone()["n"])
        jobs_today = int(con.execute("SELECT COUNT(*) n FROM jobs WHERE created_at>=?", (day_start,)).fetchone()["n"])
        last_event = int(_num(con.execute("SELECT MAX(created_at) v FROM events").fetchone()["v"])) * 1000
        last_usage = int(_num(con.execute("SELECT MAX(created_at) v FROM usage").fetchone()["v"])) * 1000
        cache_ratio = (month["cachedInputTokens"] / month["inputTokens"] * 100) if month["inputTokens"] else 0.0
        hard_pct = (month["costUsd"] / hard_monthly_usd * 100) if hard_monthly_usd else 0.0
        return {"available": True, "mode": "event-driven", "model": str(model_row["model"] if model_row else "gpt-5.6-luna"),
                "budget": {"targetMonthlyUsd": target_monthly_usd, "hardMonthlyUsd": hard_monthly_usd,
                           "monthCostUsd": month["costUsd"], "remainingTargetUsd": max(0.0, target_monthly_usd - month["costUsd"]),
                           "remainingHardUsd": max(0.0, hard_monthly_usd - month["costUsd"]),
                           "hardUtilizationPct": max(0.0, hard_pct), "targetExceeded": month["costUsd"] > target_monthly_usd},
                "usage": {"today": today, "month": month, "cacheRatioPct": max(0.0, cache_ratio)},
                "queue": {"eventsPending": _count(con, "events", "pending"), "eventsQueued": _count(con, "events", "queued"),
                          "jobsPending": _count(con, "jobs", "pending"), "jobsRunning": _count(con, "jobs", "running"),
                          "jobsBlocked": _count(con, "jobs", "blocked"), "actionsPlanned": _count(con, "action_requests", "planned"),
                          "actionsRunning": _count(con, "action_requests", "running")},
                "activity": {"eventsToday": events_today, "jobsToday": jobs_today, "lastEventAt": last_event, "lastUsageAt": last_usage},
                "projects": projects}
    finally:
        con.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only Browserless telemetry snapshot")
    parser.add_argument("--db", required=True)
    parser.add_argument("--now-ms", type=int)
    parser.add_argument("--target-monthly-usd", type=float, default=20.0)
    parser.add_argument("--hard-monthly-usd", type=float, default=30.0)
    args = parser.parse_args(argv)
    print(json.dumps(snapshot(args.db, args.now_ms, args.target_monthly_usd, args.hard_monthly_usd), ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
