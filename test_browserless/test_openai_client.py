import json
import unittest
from src.browserless.openai_client import LunaResponsesClient, MissingCredentialError, InvalidModelResponse


CHECKPOINT = '{"goal":"g","completed":[],"currentTask":"t","decisions":[],"evidence":[],"blockers":[],"nextAction":"n","doNotRepeat":[],"planVersion":"2026-09-04-v1","stage":"active","githubPr":0}'


def decision_json():
    return json.dumps({"decision":"wait","message":"No action yet","checkpoint":json.loads(CHECKPOINT)})


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

    def test_missing_key_fails_closed(self):
        with self.assertRaises(MissingCredentialError):
            LunaResponsesClient(api_key="").decide("context")

    def test_malformed_structured_decision_is_rejected(self):
        def transport(*_args):
            return {"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"decision\":\"wait\"}"}]}]}
        with self.assertRaises(InvalidModelResponse):
            LunaResponsesClient(api_key="x", transport=transport).decide("context")
