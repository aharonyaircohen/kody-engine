/**
 * Script catalog — maps profile-declared names to implementations.
 * Adding a new script: create src/scripts/<name>.ts, export it, register
 * here. Any profile referencing an unregistered script name fails at load.
 */

import type { PostflightScript, PreflightScript } from "../executables/types.js"
import { checkCoverageWithRetry } from "./checkCoverageWithRetry.js"
import { commitAndPush } from "./commitAndPush.js"
import { composePrompt } from "./composePrompt.js"
import { ensurePr } from "./ensurePr.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { fixFlow } from "./fixFlow.js"
import { initFlow } from "./initFlow.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { postIssueComment } from "./postIssueComment.js"
import { postReviewResult } from "./postReviewResult.js"
import { releaseFlow } from "./releaseFlow.js"
import { resolveFlow } from "./resolveFlow.js"
import { reviewFlow } from "./reviewFlow.js"
import { runFlow } from "./runFlow.js"
import { verify } from "./verify.js"
import { writeRunSummary } from "./writeRunSummary.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  reviewFlow,
  initFlow,
  releaseFlow,
  loadConventions,
  loadCoverageRules,
  composePrompt,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  verify,
  checkCoverageWithRetry,
  commitAndPush,
  ensurePr,
  postIssueComment,
  postReviewResult,
  writeRunSummary,
}

export const allScriptNames: Set<string> = new Set([
  ...Object.keys(preflightScripts),
  ...Object.keys(postflightScripts),
])
