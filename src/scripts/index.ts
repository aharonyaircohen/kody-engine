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
import { commitGoalState } from "./commitGoalState.js"
import { composePrompt } from "./composePrompt.js"
import { createQaGoal } from "./createQaGoal.js"
import { deriveGoalPhase } from "./deriveGoalPhase.js"
import { diagMcp } from "./diagMcp.js"
import { discoverQaContext } from "./discoverQaContext.js"
import { dispatch } from "./dispatch.js"
import { dispatchClassified } from "./dispatchClassified.js"
import { dispatchJobFileTicks } from "./dispatchJobFileTicks.js"
import { dispatchJobTicks } from "./dispatchJobTicks.js"
import { dispatchNextTask } from "./dispatchNextTask.js"
import { ensurePr } from "./ensurePr.js"
import { finalizeGoal } from "./finalizeGoal.js"
import { finishFlow } from "./finishFlow.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { fixFlow } from "./fixFlow.js"
import { handleAbandonedGoal } from "./handleAbandonedGoal.js"
import { initFlow } from "./initFlow.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { loadGoalState } from "./loadGoalState.js"
import { loadIssueContext } from "./loadIssueContext.js"
import { loadIssueStateComment } from "./loadIssueStateComment.js"
import { loadJobFromFile } from "./loadJobFromFile.js"
import { loadMemoryContext } from "./loadMemoryContext.js"
import { loadPriorArt } from "./loadPriorArt.js"
import { loadQaGuide } from "./loadQaGuide.js"
import { loadTaskContext } from "./loadTaskContext.js"
import { loadTaskState } from "./loadTaskState.js"
import { markFlowSuccess } from "./markFlowSuccess.js"
import { mergeReleasePr } from "./mergeReleasePr.js"
import { mirrorStateToPr } from "./mirrorStateToPr.js"
import { notifyTerminal } from "./notifyTerminal.js"
import { openQaIssue } from "./openQaIssue.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { parseIssueStateFromAgentResult } from "./parseIssueStateFromAgentResult.js"
import { parseJobStateFromAgentResult } from "./parseJobStateFromAgentResult.js"
import { parseReproOutput } from "./parseReproOutput.js"
import { persistArtifacts } from "./persistArtifacts.js"
import { persistFlowState } from "./persistFlowState.js"
import { postIssueComment } from "./postIssueComment.js"
import { postPlanComment } from "./postPlanComment.js"
import { postResearchComment } from "./postResearchComment.js"
import { postReviewResult } from "./postReviewResult.js"
import { recordClassification } from "./recordClassification.js"
import { recordOutcome } from "./recordOutcome.js"
import { requireFeedbackActions } from "./requireFeedbackActions.js"
import { requirePlanDeviations } from "./requirePlanDeviations.js"
import { resolveArtifacts } from "./resolveArtifacts.js"
import { resolveFlow } from "./resolveFlow.js"
import { resolvePreviewUrl } from "./resolvePreviewUrl.js"
import { resolveQaUrl } from "./resolveQaUrl.js"
import { revertFlow } from "./revertFlow.js"
import { reviewFlow } from "./reviewFlow.js"
import { runFlow } from "./runFlow.js"
import { runTickScript } from "./runTickScript.js"
import { saveGoalState } from "./saveGoalState.js"
import { saveTaskState } from "./saveTaskState.js"
import { setCommentTarget } from "./setCommentTarget.js"
import { setLifecycleLabel } from "./setLifecycleLabel.js"
import { skipAgent } from "./skipAgent.js"
import { stageMergeConflicts } from "./stageMergeConflicts.js"
import { startFlow } from "./startFlow.js"
import { syncFlow } from "./syncFlow.js"
import { verify } from "./verify.js"
import { verifyReproFails } from "./verifyReproFails.js"
import { waitForCi } from "./waitForCi.js"
import { warmupMcp } from "./warmupMcp.js"
import { writeIssueStateComment } from "./writeIssueStateComment.js"
import { writeJobStateFile } from "./writeJobStateFile.js"
import { writeRunSummary } from "./writeRunSummary.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  revertFlow,
  reviewFlow,
  syncFlow,
  initFlow,
  loadTaskState,
  loadTaskContext,
  loadIssueContext,
  loadIssueStateComment,
  loadJobFromFile,
  loadConventions,
  loadCoverageRules,
  loadMemoryContext,
  loadPriorArt,
  loadQaGuide,
  buildSyntheticPlugin,
  resolveArtifacts,
  discoverQaContext,
  resolvePreviewUrl,
  resolveQaUrl,
  composePrompt,
  setCommentTarget,
  setLifecycleLabel,
  skipAgent,
  classifyByLabel,
  diagMcp,
  warmupMcp,
  dispatchJobTicks,
  dispatchJobFileTicks,
  runTickScript,
  loadGoalState,
  handleAbandonedGoal,
  deriveGoalPhase,
  dispatchNextTask,
  finalizeGoal,
  saveGoalState,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  parseIssueStateFromAgentResult,
  parseJobStateFromAgentResult,
  parseReproOutput,
  writeIssueStateComment,
  writeJobStateFile,
  requireFeedbackActions,
  requirePlanDeviations,
  verify,
  verifyReproFails,
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
  recordClassification,
  dispatchClassified,
  notifyTerminal,
  openQaIssue,
  createQaGoal,
  recordOutcome,
  mergeReleasePr,
  waitForCi,
  markFlowSuccess,
  commitGoalState,
}

export const allScriptNames: Set<string> = new Set([
  ...Object.keys(preflightScripts),
  ...Object.keys(postflightScripts),
])
