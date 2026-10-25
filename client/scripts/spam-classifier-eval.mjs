// Run from client/: node --experimental-strip-types scripts/spam-classifier-eval.mjs
// This hand-curated corpus is a deterministic regression check, not an accuracy estimate.
import { classifySpam } from "../src/utils/spamClassification.ts";
import { SPAM_EVALUATION_CORPUS } from "../src/utils/spamClassification.corpus.ts";

const counts = { tp: 0, fp: 0, tn: 0, fn: 0, unknown: 0 };
const mismatches = [];
for (const sample of SPAM_EVALUATION_CORPUS) {
  const result = classifySpam(sample.content);
  if (result.status === "unknown") counts.unknown++;
  else if (result.spam && sample.expectedSpam) counts.tp++;
  else if (result.spam) counts.fp++;
  else if (sample.expectedSpam) counts.fn++;
  else counts.tn++;
  if (result.status !== (sample.content === null ? "unknown" : "classified") || result.spam !== sample.expectedSpam || (sample.expectedReasons && JSON.stringify(result.reasons) !== JSON.stringify(sample.expectedReasons))) {
    mismatches.push({ id: sample.id, expectedSpam: sample.expectedSpam, actualSpam: result.spam, expectedReasons: sample.expectedReasons, actualReasons: result.reasons });
  }
}

const precision = counts.tp + counts.fp === 0 ? null : counts.tp / (counts.tp + counts.fp);
const recall = counts.tp + counts.fn === 0 ? null : counts.tp / (counts.tp + counts.fn);
console.log(JSON.stringify({
  corpus: "hand-curated local heuristic regression cases",
  samples: SPAM_EVALUATION_CORPUS.length,
  counts,
  precision,
  recall,
  mismatches,
  limitation: "Not a representative dataset and not evidence of production spam accuracy, false-positive rate, or false-negative rate.",
}, null, 2));
if (mismatches.length > 0) process.exitCode = 1;
