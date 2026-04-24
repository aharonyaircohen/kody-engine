/**
 * Script catalog — maps profile-declared names to implementations.
 * Adding a new script: create src/scripts/<name>.ts, export it, register
 * here. Any profile referencing an unregistered script name fails at load.
 */

import type { PostflightScript, PreflightScript } from "../executables/types.js"
import { abortUnfinishedGitOps } from "./abortUnfinishedGitOps.js"
import { advanceFlow } from "./advanceFlow.js"
import { buildSyntheticPlugin } from "./buildSyntheticPlugin.js"
import { checkCoverageWithRetry } from "./checkCoverageWithRetry.js"
import { classifyByLabel } from "./classifyByLabel.js"
import { commitAndPush } from "./commitAndPush.js"
import { composePrompt } from "./composePrompt.js"
import { diagMcp } from "./diagMcp.js"
import { discoverQaContext } from "./discoverQaContext.js"
import { dispatch } from "./dispatch.js"
import { ensurePr } from "./ensurePr.js"
import { finishFlow } from "./finishFlow.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { fixFlow } from "./fixFlow.js"
import { initFlow } from "./initFlow.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { loadIssueContext } from "./loadIssueContext.js"
import { loadPriorArt } from "./loadPriorArt.js"
import { loadQaGuide } from "./loadQaGuide.js"
import { loadTaskState } from "./loadTaskState.js"
import { mirrorStateToPr } from "./mirrorStateToPr.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { persistArtifacts } from "./persistArtifacts.js"
import { persistFlowState } from "./persistFlowState.js"
import { postClassification } from "./postClassification.js"
import { postIssueComment } from "./postIssueComment.js"
import { postPlanComment } from "./postPlanComment.js"
import { postResearchComment } from "./postResearchComment.js"
import { postReviewResult } from "./postReviewResult.js"
import { releaseFlow } from "./releaseFlow.js"
import { requireFeedbackActions } from "./requireFeedbackActions.js"
import { requirePlanDeviations } from "./requirePlanDeviations.js"
import { resolveArtifacts } from "./resolveArtifacts.js"
import { resolveFlow } from "./resolveFlow.js"
import { resolvePreviewUrl } from "./resolvePreviewUrl.js"
import { reviewFlow } from "./reviewFlow.js"
import { runFlow } from "./runFlow.js"
import { saveTaskState } from "./saveTaskState.js"
import { setLifecycleLabel } from "./setLifecycleLabel.js"
import { skipAgent } from "./skipAgent.js"
import { stageMergeConflicts } from "./stageMergeConflicts.js"
import { startFlow } from "./startFlow.js"
import { syncFlow } from "./syncFlow.js"
import { verify } from "./verify.js"
import { watchStalePrsFlow } from "./watchStalePrsFlow.js"
import { writeRunSummary } from "./writeRunSummary.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  reviewFlow,
  syncFlow,
  initFlow,
  releaseFlow,
  watchStalePrsFlow,
  loadTaskState,
  loadIssueContext,
  loadConventions,
  loadCoverageRules,
  loadPriorArt,
  loadQaGuide,
  buildSyntheticPlugin,
  resolveArtifacts,
  discoverQaContext,
  resolvePreviewUrl,
  composePrompt,
  setLifecycleLabel,
  skipAgent,
  classifyByLabel,
  diagMcp,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  requireFeedbackActions,
  requirePlanDeviations,
  verify,
  checkCoverageWithRetry,
  abortUnfinishedGitOps,
  stageMergeConflicts,
  commitAndPush,
  ensurePr,
  postIssueComment,
  postPlanComment,
  postResearchComment,
  postReviewResult,
  persistArtifacts,
  writeRunSummary,
  saveTaskState,
  mirrorStateToPr,
  startFlow,
  dispatch,
  finishFlow,
  advanceFlow,
  persistFlowState,
  postClassification,
}

export const allScriptNames: Set<string> = new Set([
  ...Object.keys(preflightScripts),
  ...Object.keys(postflightScripts),
])
