import json
import tempfile
import unittest
from pathlib import Path
from src.browserless.core import process_once
from src.browserless.cost import BudgetGovernor
from src.browserless.openai_client import LunaResponsesClient
from src.browserless.store import BrowserlessStore
from src.browserless.ingress import ingest_observation

CHECKPOINT = json.loads('{"goal":"g","completed":[],"currentTask":"t","decisions":[],"evidence":[],"blockers":[],"nextAction":"n","doNotRepeat":[],"planVersion":"2026-09-04-v1","stage":"active","githubPr":0}')


class FakeClient:
    def __init__(self): self.calls = 0
    def decide(self, context, prompt_cache_key=""):
        self.calls += 1
        return {"response_id":"r1","decision":{"decision":"wait","message":"ok","actions":[],"checkpoint":CHECKPOINT},
                "usage":{"input_tokens":1000,"cached_input_tokens":500,"output_tokens":100}}


class CoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = BrowserlessStore(str(Path(self.tmp.name)/"core.sqlite3"))
        self.store.register_project("p1","2026-09-04-v1","ANCHOR",CHECKPOINT)
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def test_idle_makes_zero_api_calls(self):
        client = FakeClient()
        result = process_once(self.store, client)
        self.assertEqual(result["status"], "idle")
        self.assertFalse(result["api_called"])
        self.assertEqual(client.calls, 0)

    def test_one_event_creates_one_luna_job(self):
        self.store.enqueue_event("p1","evt-1","github",{"summary":"CI finished"})
        client = FakeClient()
        result = process_once(self.store, client)
        self.assertEqual(result["status"], "done")
        self.assertEqual(client.calls, 1)
        self.assertGreater(result["cost_usd"], 0)
        self.assertEqual(process_once(self.store, client)["status"], "idle")
        self.assertEqual(client.calls, 1)

    def test_missing_api_key_blocks_without_crashing_queue(self):
        self.store.enqueue_event("p1","evt-1","runtime",{})
        result = process_once(self.store, LunaResponsesClient(api_key=""))
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "missing_openai_api_key")

    def test_transient_api_error_is_deferred_without_busy_retry(self):
        self.store.enqueue_event("p1","evt-1","runtime",{})
        class FailingClient:
            def __init__(self): self.calls=0
            def decide(self, *_args, **_kwargs): self.calls += 1; raise RuntimeError("network")
        client = FailingClient()
        first = process_once(self.store, client)
        self.assertEqual(first["status"], "deferred")
        self.assertEqual(first["retry_seconds"], 60)
        second = process_once(self.store, client)
        self.assertEqual(second["status"], "idle")
        self.assertEqual(client.calls, 1)

    def test_unchanged_observation_never_creates_second_luna_call(self):
        doc = {"material":{"status":"success","sha":"abc"},"summary":"CI success"}
        ingest_observation(self.store,"p1","github","ci:abc",doc)
        client = FakeClient()
        self.assertEqual(process_once(self.store, client)["status"], "done")
        self.assertFalse(ingest_observation(self.store,"p1","github","ci:abc",doc)["changed"])
        self.assertEqual(process_once(self.store, client)["status"], "idle")
        self.assertEqual(client.calls, 1)

    def test_read_only_action_is_persisted_as_planned_not_executed(self):
        self.store.enqueue_event("p1","evt-action","github",{"summary":"Need evidence"})
        class ReadClient:
            def __init__(self): self.calls=0
            def decide(self, *_args, **_kwargs):
                self.calls += 1
                return {"response_id":"r2","decision":{"decision":"continue","message":"inspect",
                        "actions":[{"type":"github.read","target":"repo#107","purpose":"fresh state"}],
                        "checkpoint":CHECKPOINT},
                        "usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50}}
        client = ReadClient()
        result = process_once(self.store, client)
        self.assertEqual(result["status"], "done")
        actions = self.store.actions_for_job(result["job_id"])
        self.assertEqual(actions, [{"sequence":0,"type":"github.read","target":"repo#107","purpose":"fresh state","payload":"","status":"planned"}])
        self.assertEqual(self.store.counts()["planned_actions"], 1)

    def test_budget_blocks_before_api_call(self):
        self.store.enqueue_event("p1","evt-1","runtime",{})
        client = FakeClient()
        result = process_once(self.store, client, BudgetGovernor(hard_budget_usd=0.0001))
        self.assertEqual(result["reason"], "monthly_budget_exhausted")
        self.assertEqual(client.calls, 0)

    def test_process_once_passes_only_current_project_capabilities(self):
        self.store.enqueue_event("p1","evt-cap","operator.task",{"summary":"capability proof"})
        class CaptureClient:
            def __init__(self): self.context=""
            def decide(self,context,**_kwargs):
                self.context=context
                return {"response_id":"cap","decision":{"decision":"wait","message":"ok","actions":[],"checkpoint":CHECKPOINT},
                        "usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}
        client=CaptureClient()
        caps={"p1":{"repo":{"mine":{"testAliases":["unit"]}}},"other":{"repo":{"SECRET_OTHER":{}}}}
        result=process_once(self.store,client,capabilities_by_project=caps)
        self.assertEqual(result["status"],"done")
        self.assertIn("mine",client.context); self.assertIn("unit",client.context)
        self.assertNotIn("SECRET_OTHER",client.context)
    def test_retry_exhausted_same_action_is_blocked_before_replanning(self):
        payload={"material":{"ok":False,"kind":"repo.patch","target":"repo","error_code":"repo_patch_invalid",
                             "failure_attempt":2,"retry_exhausted":True},"summary":"patch failed twice"}
        self.store.enqueue_event("p1","evt-exhausted","observation.evidence",payload)
        class RetryClient:
            def decide(self,*_args,**_kwargs):
                return {"response_id":"retry","decision":{"decision":"continue","message":"retry",
                    "actions":[{"type":"repo.patch","target":"repo","purpose":"retry","payload":"diff"}],
                    "checkpoint":CHECKPOINT},"usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":50}}
        result=process_once(self.store,RetryClient())
        self.assertEqual(result["status"],"blocked"); self.assertEqual(result["reason"],"repeated_action_failure")
        self.assertEqual(self.store.counts()["planned_actions"],0)
