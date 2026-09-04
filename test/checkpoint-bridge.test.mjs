import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/bridge.mjs";
import { ProjectRuntimeStore } from "../src/runtime-store.mjs";

async function post(base, body) {
  const response=await fetch(`${base}/heartbeat`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return {response,json:await response.json()};
}

function checkpoint() {
  return {goal:"Ship v2",completed:["#63"],currentTask:"#64",decisions:["fail closed"],evidence:["PR #68"],blockers:[],nextAction:"merge",doNotRepeat:["redo #63"],planVersion:"v1",stage:"complete",githubPr:68};
}

test("complete checkpoint stays pending until configured evidence verifies", async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"autopilot-checkpoint-bridge-"));
  const project={id:"demo",name:"Demo",enabled:true,backend:"browser",chatUrl:"https://chatgpt.com/c/demo",planVersion:"v1",checkpointLedger:{enabled:true,evidenceCheckSeconds:30,evidence:{repoPath:"",requireCleanWorktree:false,requireHeadAdvanceFrom:"",github:{repository:"eNgine9r/chatgpt-autopilot",requireMergedPr:true,matchLocalHead:false}}}};
  const file=path.join(root,"projects.json"); fs.writeFileSync(file,JSON.stringify({projects:[project]}));
  const runtimeStore=new ProjectRuntimeStore({stateDir:root,projects:[project]});
  let evidenceOk=false, checks=0;
  const evidenceVerifier=async()=>({configured:true,ok:evidenceOk,checkedAt:Date.now(),reasons:evidenceOk?[]:["github_pr_not_merged"],localGit:null,github:{configured:true,ok:evidenceOk,pr:68}});
  const server=await createBridgeServer({host:"127.0.0.1",port:0,projects:[project],projectsFile:file,runtimeStore,evidenceVerifier,notifier:{enabled:false,async send(){return false;}},logger:{info(){},error(){}},progressWatchdog:{observe(){return {ok:true};}}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  let result=await post(base,{projectId:"demo",progressKey:"p1",status:"assistant",lastTurnRole:"assistant",lastTurnId:"t1",checkpoint:checkpoint()});
  assert.equal(result.response.status,200);
  let state=runtimeStore.snapshot("demo");
  assert.equal(state.checkpoint.revision,1);
  assert.equal(state.checkpoint.completionStatus,"complete_pending_evidence");
  assert.equal(state.checkpoint.evidenceHealth.ok,false);

  runtimeStore.updateCheckpointEvidence("demo",{...state.checkpoint.evidenceHealth,checkedAt:0},"complete_pending_evidence");
  evidenceOk=true;
  result=await post(base,{projectId:"demo",progressKey:"p1",status:"assistant",lastTurnRole:"assistant",lastTurnId:"t1",checkpoint:checkpoint()});
  state=runtimeStore.snapshot("demo");
  assert.equal(state.checkpoint.revision,1);
  assert.equal(state.checkpoint.completionStatus,"complete_verified");
  assert.equal(state.checkpoint.evidenceHealth.ok,true);

  result=await post(base,{projectId:"demo",progressKey:"p2",status:"assistant",lastTurnRole:"assistant",lastTurnId:"t2",checkpoint:{...checkpoint(),planVersion:"wrong",currentTask:"drift"}});
  assert.equal(result.response.status,200);
  state=runtimeStore.snapshot("demo");
  assert.equal(state.checkpoint.revision,1);
  assert.equal(state.checkpoint.currentTask,"#64");
});