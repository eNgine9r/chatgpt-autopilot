import test from "node:test";
import assert from "node:assert/strict";
import { verifyProjectEvidence } from "../src/evidence-verifier.mjs";

function project(evidence) {
  return { checkpointLedger:{ evidence } };
}

test("local git evidence verifies clean worktree and head advance", async () => {
  const calls=[];
  const runCommand=async (file,args) => {
    calls.push([file,...args].join(" "));
    const joined=args.join(" ");
    if(joined.includes("rev-parse HEAD")) return "newsha";
    if(joined.includes("branch --show-current")) return "main";
    if(joined.includes("status --porcelain")) return "";
    if(joined.includes("merge-base --is-ancestor")) return "";
    throw new Error("unexpected command");
  };
  const result=await verifyProjectEvidence(project({repoPath:"/repo",requireCleanWorktree:true,requireHeadAdvanceFrom:"oldsha",github:{}}),{}, {runCommand});
  assert.equal(result.configured,true); assert.equal(result.ok,true);
  assert.equal(result.localGit.clean,true); assert.equal(result.localGit.advanced,true);
  assert.ok(calls.every((call)=>call.startsWith("git ")));
});
test("dirty local worktree cannot verify completion", async () => {
  const runCommand=async (_file,args) => {
    const joined=args.join(" ");
    if(joined.includes("rev-parse HEAD")) return "sha";
    if(joined.includes("branch --show-current")) return "main";
    if(joined.includes("status --porcelain")) return " M src/x.js";
    return "";
  };
  const result=await verifyProjectEvidence(project({repoPath:"/repo",requireCleanWorktree:true,requireHeadAdvanceFrom:"",github:{}}),{}, {runCommand});
  assert.equal(result.ok,false);
  assert.ok(result.reasons.includes("worktree_dirty"));
});

test("merged GitHub PR evidence is read-only and can verify completion", async () => {
  const calls=[];
  const runCommand=async (file,args) => {
    calls.push([file,...args]);
    if(file!=="gh") throw new Error("unexpected binary");
    return JSON.stringify({state:"MERGED",mergedAt:"2026-09-04T10:00:00Z",mergeCommit:{oid:"merge"},headRefOid:"head"});
  };
  const result=await verifyProjectEvidence(project({repoPath:"",requireCleanWorktree:false,requireHeadAdvanceFrom:"",github:{repository:"eNgine9r/chatgpt-autopilot",requireMergedPr:true,matchLocalHead:false}}),{githubPr:67},{runCommand});
  assert.equal(result.ok,true); assert.equal(result.github.pr,67);
  assert.equal(calls[0][0],"gh"); assert.deepEqual(calls[0].slice(1,4),["pr","view","67"]);
});

test("completion remains unverified when required GitHub PR is absent", async () => {
  const result=await verifyProjectEvidence(project({repoPath:"",requireCleanWorktree:false,requireHeadAdvanceFrom:"",github:{repository:"eNgine9r/chatgpt-autopilot",requireMergedPr:true}}),{githubPr:0},{runCommand:async()=>{throw new Error("should not run");}});
  assert.equal(result.ok,false);
  assert.ok(result.reasons.includes("github_pr_missing"));
});