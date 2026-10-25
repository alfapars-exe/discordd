import {test} from "node:test";
import assert from "node:assert/strict";
import {interpretCandidateProbabilities,CANDIDATE} from "./verify-disturbing-model-candidate.mjs";
test("keeps a small gore score uncertain if the sexual class dominates",()=>{
  assert.equal(interpretCandidateProbabilities([0.01,0.95,0.04]).verdict,"uncertain");
  assert.equal(interpretCandidateProbabilities([0.8,0.1,0.1]).verdict,"positive");
  assert.equal(interpretCandidateProbabilities([0.01,0.04,0.95]).verdict,"negative");
  assert.equal(interpretCandidateProbabilities([0.1,0.1,0.8]).verdict,"uncertain");
});
test("rejects invalid, unnormalized and non-finite output vectors",()=>{
  for(const values of [[],[1,0],[0,0,0],[NaN,0,1],[-1,1,1],[1.01,0,0]])assert.throws(()=>interpretCandidateProbabilities(values),/invalid_candidate_output/);
  assert.match(CANDIDATE.sha256,/^[a-f0-9]{64}$/);
});
