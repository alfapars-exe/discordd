import {describe,expect,it} from "vitest";
import {interpretDisturbingProbabilities} from "./disturbingModelContract";

describe("independent disturbing category",()=>{
  it("requires strong safe-class support for a negative result",()=>{
    expect(interpretDisturbingProbabilities([0.01,0.98,0.01]).verdict).toBe("uncertain");
    expect(interpretDisturbingProbabilities([0.01,0.01,0.98]).verdict).toBe("negative");
    expect(interpretDisturbingProbabilities([0.8,0.1,0.1]).verdict).toBe("positive");
    expect(interpretDisturbingProbabilities([0.2,0.2,0.6]).verdict).toBe("uncertain");
  });
  it("rejects malformed probability vectors",()=>{
    for(const values of [[],[0,1],[1,1,1],[NaN,0,1],[-1,1,1],[Infinity,0,0]])expect(()=>interpretDisturbingProbabilities(values)).toThrow("invalid_disturbing_output");
  });
});
