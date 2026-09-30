import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint=process.env.MCP_ENDPOINT;
if(!endpoint) throw new Error("MCP_ENDPOINT is required");

const client=new Client(
  {name:"teaching-module-smoke",version:"1.0.0"},
  {versionNegotiation:{mode:"legacy"},listMaxPages:8}
);
const transport=new StreamableHTTPClientTransport(new URL(endpoint));

try{
  await client.connect(transport);
  const {tools}=await client.listTools();
  const required=[
    "teaching.list_curricula",
    "teaching.start",
    "teaching.next_activity",
    "teaching.prepare_attempt",
    "teaching.commit_response",
    "teaching.record_evaluation",
    "teaching.snapshot"
  ];
  for(const name of required) assert.ok(tools.some(t=>t.name===name),name+" missing");

  async function call(name,args){
    const tool=tools.find(t=>t.name===name);
    const result=await client.callTool({name,arguments:args},undefined,{toolDefinition:tool});
    if(result?.isError) throw new Error(name+" failed: "+JSON.stringify(result));
    return result.structuredContent;
  }

  const started=await call("teaching.start",{
    preset:"mixing.eq.core.v1",
    goal:"Learn EQ by reasoning and practice, not recipes."
  });
  assert.equal(started.next_activity.kind,"diagnostic");
  assert.equal(started.next_activity.conceptId,"eq_controls");

  const prepared=await call("teaching.prepare_attempt",{
    state_token:started.state_token,
    concept_id:"eq_controls",
    activity_kind:"diagnostic",
    task:"Explain what Frequency, Gain, and Q each control.",
    rubric:[
      {criterion:"Frequency chooses the target spectral area",weight:1},
      {criterion:"Gain changes level in that area",weight:1},
      {criterion:"Q changes bandwidth",weight:1}
    ]
  });

  const committed=await call("teaching.commit_response",{
    state_token:prepared.state_token,
    attempt_id:prepared.attempt.id,
    learner_response:"Frequency chooses where, gain changes level, and Q controls how broad or narrow the move is.",
    confidence:4
  });

  const evaluated=await call("teaching.record_evaluation",{
    state_token:committed.state_token,
    attempt_id:prepared.attempt.id,
    score:0.95,
    misconceptions:[],
    evaluator:"model",
    evidence_strength:"medium"
  });
  assert.equal(evaluated.concept_status.masteryReady,false);

  const snapshot=await call("teaching.snapshot",{state_token:evaluated.state_token});
  const concept=snapshot.snapshot.concepts.find(x=>x.id==="eq_controls");
  assert.equal(concept.attempts,1);
  assert.ok(concept.estimated>0.25);
  console.log("TEACHING_MODULE=PASS concept="+concept.id+" estimate="+concept.estimated+" next="+evaluated.next_activity.kind);
} finally {
  try{await client.close();}catch{}
}
