from .context import compile_context
from .cost import BudgetGovernor, luna_cost
from .openai_client import InvalidModelResponse, MissingCredentialError, MODEL


def process_once(store, client, governor=None, capabilities_by_project=None, github_quiet_seconds=0):
    governor = governor or BudgetGovernor()
    store.ensure_jobs(github_quiet_seconds=github_quiet_seconds)
    job = store.claim_job()
    if not job:
        return {"status": "idle", "api_called": False}

    project = store.project(job["project_id"])
    capabilities = (capabilities_by_project or {}).get(project["id"], {})
    context = compile_context(project, job, capabilities)
    preflight = governor.preflight(store.month_cost(), context)
    if not preflight["allowed"]:
        store.block_job(job["id"], "monthly_budget_exhausted")
        return {"status": "blocked", "reason": "monthly_budget_exhausted", "api_called": False, "job_id": job["id"]}

    try:
        result = client.decide(context, prompt_cache_key=f"autopilot:{project['id']}:v1")
    except MissingCredentialError:
        store.block_job(job["id"], "missing_openai_api_key")
        return {"status": "blocked", "reason": "missing_openai_api_key", "api_called": False, "job_id": job["id"]}
    except InvalidModelResponse as exc:
        usage = getattr(exc, "usage", {}) or {}
        cost = luna_cost(usage.get("input_tokens", 0), usage.get("cached_input_tokens", 0), usage.get("output_tokens", 0))
        store.record_usage(project["id"], MODEL, usage, cost, getattr(exc, "response_id", ""))
        store.block_job(job["id"], f"invalid_model_response:{exc}")
        return {"status": "blocked", "reason": "invalid_model_response", "api_called": True, "job_id": job["id"], "cost_usd": cost}
    except Exception as exc:
        retry_delays = (60, 300, 900, 3600)
        delay = retry_delays[min(max(1, int(job.get("attempts", 1))) - 1, len(retry_delays) - 1)]
        store.defer_job(job["id"], f"api_error:{type(exc).__name__}", delay)
        return {"status": "deferred", "reason": "api_error", "retry_seconds": delay, "api_called": True, "job_id": job["id"]}

    usage = result["usage"]
    cost = luna_cost(usage["input_tokens"], usage["cached_input_tokens"], usage["output_tokens"])
    store.record_usage(project["id"], MODEL, usage, cost, result.get("response_id", ""))
    decision = result["decision"]
    material = (job.get("payload") or {}).get("material")
    if isinstance(material, dict) and material.get("retry_exhausted") and decision.get("decision") == "continue":
        failed_type, failed_target = str(material.get("kind") or ""), str(material.get("target") or "")
        if any(action.get("type") == failed_type and action.get("target") == failed_target
               for action in list(decision.get("actions") or [])):
            store.block_job(job["id"], "repeated_action_failure")
            return {"status":"blocked", "reason":"repeated_action_failure", "api_called":True,
                    "job_id":job["id"], "cost_usd":cost}
    store.update_checkpoint(project["id"], decision["checkpoint"])
    store.finish_job(job["id"], decision)
    return {"status": "done", "api_called": True, "job_id": job["id"], "decision": decision["decision"], "cost_usd": cost}
