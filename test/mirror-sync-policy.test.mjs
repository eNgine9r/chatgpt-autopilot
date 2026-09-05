import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/mirror-sync-policy.js");
const Mirror = globalThis.AutopilotMirrorSyncPolicy;

test("mirror probe starts only from a fresh idle owning tab", () => {
  const base = { enabled:true, pending:false, sourcePresent:true, sourceFresh:true, sourceKnown:true, sourceGenerating:false, sourceBlocked:false, sourceTurnId:"turn-1", due:true };
  assert.equal(Mirror.shouldStartProbe(base), true);
  assert.equal(Mirror.shouldStartProbe({ ...base, sourceGenerating:true }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, sourceFresh:false }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, sourceKnown:false }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, sourceBlocked:true }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, pending:true }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, due:false }), false);
  assert.equal(Mirror.shouldStartProbe({ ...base, sourceTurnId:"" }), false);
});

test("same remote turn is a no-op", () => {
  const result = Mirror.probeDisposition({
    sourceTurnId:"turn-1",
    snapshot:{ ok:true, generatingKnown:true, generating:false, role:"assistant", turnId:"turn-1", assistantFinished:true }
  });
  assert.equal(result.action, "same");
});


test("different probe turn is not newer unless ordered history proves it", () => {
  assert.equal(Mirror.provesNewerTurn("turn-2", { turnId:"turn-1", recentTurnIds:["turn-1"] }), false);
  assert.equal(Mirror.provesNewerTurn("turn-1", { turnId:"turn-2", recentTurnIds:["turn-2"] }), false);
  assert.equal(Mirror.provesNewerTurn("turn-1", { turnId:"turn-2", recentTurnIds:["turn-1","turn-2"] }), true);
  const result = Mirror.probeDisposition({ sourceTurnId:"turn-2", snapshot:{ ok:true, generatingKnown:true, generating:false, role:"assistant", turnId:"turn-1", recentTurnIds:["turn-1"], assistantFinished:true } });
  assert.equal(result.action, "wait");
});

test("newer active remote generation never permits refresh", () => {
  const result = Mirror.probeDisposition({
    sourceTurnId:"turn-1",
    snapshot:{ ok:true, generatingKnown:true, generating:true, role:"assistant", turnId:"turn-2", recentTurnIds:["turn-1","turn-2"], assistantFinished:false }
  });
  assert.equal(result.action, "wait");
});
test("newer explicit finished turn permits refresh", () => {
  const result = Mirror.probeDisposition({
    sourceTurnId:"turn-1",
    snapshot:{ ok:true, generatingKnown:true, generating:false, role:"assistant", turnId:"turn-2", recentTurnIds:["turn-1","turn-2"], assistantFinished:true }
  });
  assert.equal(result.action, "refresh");
});

test("unknown assistant completion requires a stable idle settle window", () => {
  const snapshot = {
    ok:true, generatingKnown:true, generating:false, composerPresent:true,
    role:"assistant", turnId:"turn-2", recentTurnIds:["turn-1","turn-2"], assistantFinished:null, textFingerprint:"abc"
  };
  const first = Mirror.probeDisposition({ sourceTurnId:"turn-1", snapshot, now:100000, settleMs:30000 });
  assert.equal(first.action, "settle");
  const second = Mirror.probeDisposition({
    sourceTurnId:"turn-1", snapshot, observedKey:first.key, observedAt:first.observedAt,
    now:129999, settleMs:30000
  });
  assert.equal(second.action, "settle");
  const third = Mirror.probeDisposition({
    sourceTurnId:"turn-1", snapshot, observedKey:first.key, observedAt:first.observedAt,
    now:130000, settleMs:30000
  });
  assert.equal(third.action, "refresh");
});
test("remote auth, rate-limit or safety blockers fail closed", () => {
  for (const key of ["authBlocked", "rateLimited", "safetyBlocked"]) {
    const result = Mirror.probeDisposition({
      sourceTurnId:"turn-1",
      snapshot:{ ok:true, generatingKnown:true, generating:false, role:"assistant", turnId:"turn-2", recentTurnIds:["turn-1","turn-2"], assistantFinished:true, [key]:true }
    });
    assert.equal(result.action, "blocked");
  }
});

test("mirror probe tab identity is explicit and cannot be confused with the owner", () => {
  assert.equal(Mirror.isProbeTab({ tabId:42 }, 42), true);
  assert.equal(Mirror.isProbeTab({ tabId:42 }, 43), false);
  assert.equal(Mirror.isProbeTab({}, 42), false);
});
