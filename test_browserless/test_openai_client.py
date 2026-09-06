import json
import unittest
from src.browserless.openai_client import LunaResponsesClient, MissingCredentialError, InvalidModelResponse


CHECKPOINT = '{"goal":"g","completed":[],"currentTask":"t","decisions":[],"evidence":[],"blockers":[],"nextAction":"n","doNotRepeat":[],"planVersion":"2026-09-04-v1","stage":"active","githubPr":0}'


def decision_json():
    return json.dumps({"decision":"wait","message":"No action yet","actions":[],"checkpoint":json.loads(CHECKPOINT)})


class OpenAIClientTest(unittest.TestCase):
    def test_luna_responses_request_and_usage(self):
        seen = {}
        def transport(url, headers, body, timeout):
            seen.update({"url":url,"headers":headers,"body":body,"timeout":timeout})
            return {"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":decision_json()}]}],
                    "usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":600},"output_tokens":200}}
        result = LunaResponsesClient(api_key="test-key", transport=transport).decide("context")
        self.assertEqual(seen["body"]["model"], "gpt-5.6-luna")
        self.assertEqual(seen["body"]["reasoning"]["effort"], "low")
        self.assertEqual(seen["body"]["text"]["format"]["type"], "json_schema")
        self.assertFalse(seen["body"]["store"])
        self.assertEqual(result["usage"]["cached_input_tokens"], 600)
        self.assertEqual(result["decision"]["decision"], "wait")
        self.assertEqual(result["decision"]["actions"], [])
        self.assertEqual(seen["body"]["text"]["format"]["schema"]["properties"]["actions"]["items"]["properties"]["type"]["enum"],
                         ["github.read", "runtime.read", "git.read", "evidence.read", "repo.read", "repo.prepare", "repo.patch", "repo.test", "repo.commit", "repo.publish"])
        instructions = seen["body"]["instructions"]
        self.assertIn("return exactly one action total in that decision", instructions)
        self.assertIn("one repo.test action per Luna turn", instructions)
        self.assertIn("payload must be exactly the empty string", instructions)
        self.assertIn("github.read prfiles", instructions)
        payload_schema = seen["body"]["text"]["format"]["schema"]["properties"]["actions"]["items"]["properties"]["payload"]
        self.assertIn("empty string", payload_schema["description"])

    def test_missing_key_fails_closed(self):
        with self.assertRaises(MissingCredentialError):
            LunaResponsesClient(api_key="").decide("context")

    def test_malformed_structured_decision_is_rejected(self):
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"decision\":\"wait\"}"}]}]}
        with self.assertRaises(InvalidModelResponse):
            LunaResponsesClient(api_key="x", transport=transport).decide("context")
    def test_write_action_is_rejected_even_when_response_is_otherwise_valid(self):
        payload = {"decision":"continue","message":"write",
                   "actions":[{"type":"github.write","target":"issue:1","purpose":"mutate","payload":""}],
                   "checkpoint":json.loads(CHECKPOINT)}
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(payload)}]}]}
        with self.assertRaises(InvalidModelResponse):
            LunaResponsesClient(api_key="x", transport=transport).decide("context")

    def test_non_continue_decision_cannot_queue_actions(self):
        payload = {"decision":"wait","message":"wait",
                   "actions":[{"type":"github.read","target":"repo","purpose":"later","payload":""}],
                   "checkpoint":json.loads(CHECKPOINT)}
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(payload)}]}]}
        with self.assertRaises(InvalidModelResponse):
            LunaResponsesClient(api_key="x", transport=transport).decide("context")

    def test_read_only_action_contract_is_accepted(self):
        payload = {"decision":"continue","message":"inspect",
                   "actions":[{"type":"github.read","target":"eNgine9r/chatgpt-autopilot#107","purpose":"refresh evidence","payload":""}],
                   "checkpoint":json.loads(CHECKPOINT)}
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(payload)}]}]}
        result = LunaResponsesClient(api_key="x", transport=transport).decide("context")
        self.assertEqual(result["decision"]["actions"][0]["type"], "github.read")
    def test_repo_patch_action_contract_is_accepted(self):
        diff="diff --git a/src/browserless/core.py b/src/browserless/core.py\n--- a/src/browserless/core.py\n+++ b/src/browserless/core.py\n@@ -1 +1 @@\n-old\n+new\n"
        payload={"decision":"continue","message":"patch","actions":[{"type":"repo.patch","target":"autopilot","purpose":"apply bounded diff","payload":diff}],"checkpoint":json.loads(CHECKPOINT)}
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(payload)}]}]}
        result=LunaResponsesClient(api_key="x",transport=transport).decide("context")
        self.assertEqual(result["decision"]["actions"][0]["payload"],diff)
    def test_invalid_model_response_preserves_api_usage_for_accounting(self):
        payload = {"decision":"continue","message":"inspect",
                   "actions":[{"type":"github.read","target":"repo","purpose":"inspect","payload":"unexpected"}],
                   "checkpoint":json.loads(CHECKPOINT)}
        def transport(*_args):
            return {"id":"resp_bad","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(payload)}]}],
                    "usage":{"input_tokens":321,"input_tokens_details":{"cached_tokens":21},"output_tokens":45}}
        with self.assertRaises(InvalidModelResponse) as cm:
            LunaResponsesClient(api_key="x", transport=transport).decide("context")
        self.assertEqual(str(cm.exception), "action_payload_not_allowed")
        self.assertEqual(cm.exception.response_id, "resp_bad")
        self.assertEqual(cm.exception.usage, {"input_tokens":321,"cached_input_tokens":21,"output_tokens":45})
