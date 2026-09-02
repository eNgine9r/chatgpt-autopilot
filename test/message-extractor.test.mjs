import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/message-extractor.js", import.meta.url), "utf8");
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context);
const Extractor = context.globalThis.AutopilotMessageExtractor;

test("finds only the requested finished assistant message", () => {
  const target = {
    id: "msg-2",
    author: { role: "assistant" },
    status: "finished_successfully",
    content: { content_type: "text", parts: ["AUTOPILOT_READY"] }
  };
  const noise = {
    id: "msg-1",
    author: { role: "user" },
    status: "finished_successfully",
    content: { parts: ["ignore"] }
  };
  assert.equal(Extractor.findMessageText([{ nested: [noise, target] }], "msg-2"), "AUTOPILOT_READY");
  assert.equal(Extractor.findMessageText([{ nested: [target] }], "missing"), "");
});

test("rejects unfinished assistant content", () => {
  const target = {
    id: "msg-3",
    author: { role: "assistant" },
    status: "in_progress",
    content: { content_type: "text", parts: ["partial"] }
  };
  assert.equal(Extractor.findMessageText([target], "msg-3"), "");
});

test("extracts React fiber message matching data-message-id", () => {
  const message = {
    id: "msg-4",
    author: { role: "assistant" },
    status: "finished_successfully",
    content: { content_type: "text", parts: ["line one", "line two"] }
  };
  const node = {
    innerText: "",
    getAttribute(name) { return name === "data-message-id" ? "msg-4" : null; },
    "__reactFiber$test": {
      memoizedState: { nested: [message] },
      memoizedProps: null,
      pendingProps: null,
      updateQueue: null,
      return: null
    }
  };
  assert.equal(Extractor.extractAssistantText(node), "line one\nline two");
});

test("prefers direct DOM text and does not inspect unrelated state", () => {
  const node = {
    innerText: "Visible response",
    getAttribute() { return "msg-5"; },
    "__reactFiber$test": { memoizedState: { secret: "internal" }, return: null }
  };
  assert.equal(Extractor.extractAssistantText(node), "Visible response");
});
