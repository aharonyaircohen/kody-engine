/**
 * Script catalog — maps profile-declared names to implementations.
 * Adding a new script: create src/scripts/<name>.ts, export it, register
 * here. Any profile referencing an unregistered script name fails at load.
 */

import type { PostflightScript, PreflightScript } from "../implementations/types.js"
import { abortUnfinishedGitOps } from "./abortUnfinishedGitOps.js"
import { advanceFlow } from "./advanceFlow.js"
import { advanceManagedGoal } from "./advanceManagedGoal.js"
import { appendCompanyActivity } from "./appendCompanyActivity.js"
import { applyCapabilityReports } from "./applyCapabilityReports.js"
import { buildSyntheticPlugin } from "./buildSyntheticPlugin.js"
import { checkCoverageWithRetry } from "./checkCoverageWithRetry.js"
import { classifyByLabel } from "./classifyByLabel.js"
import { commitAndPush } from "./commitAndPush.js"
import { commitGoalState } from "./commitGoalState.js"
import { composePrompt } from "./composePrompt.js"
import { createQaGoal } from "./createQaGoal.js"
import { deriveQaScopeFromIssue } from "./deriveQaScopeFromIssue.js"
import { diagMcp } from "./diagMcp.js"
import { discoverQaContext } from "./discoverQaContext.js"
import { dispatch } from "./dispatch.js"
import { dispatchCapabilityFileTicks } from "./dispatchCapabilityFileTicks.js"
import { dispatchCapabilityTicks } from "./dispatchCapabilityTicks.js"
import { dispatchClassified } from "./dispatchClassified.js"
import { dispatchNextTaskJob } from "./dispatchNextTaskJob.js"
import { ensurePr } from "./ensurePr.js"
import { evaluateAgencyBoundariesScript } from "./evaluateAgencyBoundaries.js"
import { failOnceTaskJob } from "./failOnceTaskJob.js"
import { finalizeTerminal } from "./finalizeTerminal.js"
import { finishFlow } from "./finishFlow.js"
import { fixCiFlow } from "./fixCiFlow.js"
import { fixFlow } from "./fixFlow.js"
import { initFlow } from "./initFlow.js"
import { loadAgentAdhoc } from "./loadAgentAdhoc.js"
import { loadCapabilityState } from "./loadCapabilityState.js"
import { loadCompanyIntents } from "./loadCompanyIntents.js"
import { loadCompanyPortfolio } from "./loadCompanyPortfolio.js"
import { loadConventions } from "./loadConventions.js"
import { loadCoverageRules } from "./loadCoverageRules.js"
import { loadGoalState } from "./loadGoalState.js"
import { loadIssueContext } from "./loadIssueContext.js"
import { loadIssueStateComment } from "./loadIssueStateComment.js"
import { loadJobFromFile } from "./loadJobFromFile.js"
import { loadLinkedFinding } from "./loadLinkedFinding.js"
import { loadMemoryContext } from "./loadMemoryContext.js"
import { loadPriorArt } from "./loadPriorArt.js"
import { loadQaContext } from "./loadQaContext.js"
import { loadTaskContext } from "./loadTaskContext.js"
import { loadTaskState } from "./loadTaskState.js"
import { markFlowSuccess } from "./markFlowSuccess.js"
import { mergeFlow } from "./mergeFlow.js"
import { mergeReleasePr } from "./mergeReleasePr.js"
import { mirrorStateToPr } from "./mirrorStateToPr.js"
import { notifyTerminal } from "./notifyTerminal.js"
import { openAgencyModelReviewPr } from "./openAgencyModelReviewPr.js"
import { openQaIssue } from "./openQaIssue.js"
import { parseAgentResult } from "./parseAgentResult.js"
import { parseIssueStateFromAgentResult } from "./parseIssueStateFromAgentResult.js"
import { parseJobStateFromAgentResult } from "./parseJobStateFromAgentResult.js"
import { parseReproOutput } from "./parseReproOutput.js"
import { persistArtifacts } from "./persistArtifacts.js"
import { persistFlowState } from "./persistFlowState.js"
import { planTaskJobs } from "./planTaskJobs.js"
import { postAgentComment } from "./postAgentComment.js"
import { postIssueComment } from "./postIssueComment.js"
import { postPlanComment } from "./postPlanComment.js"
import { postResearchComment } from "./postResearchComment.js"
import { postReviewResult } from "./postReviewResult.js"
import { prepareBrowserAuth } from "./prepareBrowserAuth.js"
import { promoteQaGoal } from "./promoteQaGoal.js"
import { publishReport } from "./publishReport.js"
import { recordClassification } from "./recordClassification.js"
import { recordOutcome } from "./recordOutcome.js"
import { requireDeliveryArtifacts } from "./requireDeliveryArtifacts.js"
import { requireFeedbackActions } from "./requireFeedbackActions.js"
import { requirePlanDeviations } from "./requirePlanDeviations.js"
import { resolveArtifacts } from "./resolveArtifacts.js"
import { resolveFlow } from "./resolveFlow.js"
import { resolvePreviewUrl } from "./resolvePreviewUrl.js"
import { resolveQaUrl } from "./resolveQaUrl.js"
import { revertFlow } from "./revertFlow.js"
import { reviewFlow } from "./reviewFlow.js"
import { runFlow } from "./runFlow.js"
import { runPreviewBuild } from "./runPreviewBuild.js"
import { runScheduledImplementationTick } from "./runScheduledImplementationTick.js"
import { runTickScript } from "./runTickScript.js"
import { saveManagedGoalState } from "./saveManagedGoalState.js"
import { saveTaskState } from "./saveTaskState.js"
import { setCommentTarget } from "./setCommentTarget.js"
import { setLifecycleLabel } from "./setLifecycleLabel.js"
import { skipAgent } from "./skipAgent.js"
import { stageMergeConflicts } from "./stageMergeConflicts.js"
import { startFlow } from "./startFlow.js"
import { syncFlow } from "./syncFlow.js"
import { validateAgencyModelProposal } from "./validateAgencyModelProposal.js"
import { verify } from "./verify.js"
import { verifyReproFails } from "./verifyReproFails.js"
import { verifyWithRetry } from "./verifyWithRetry.js"
import { waitForCi } from "./waitForCi.js"
import { warmupMcp } from "./warmupMcp.js"
import { writeAgentRunSummary } from "./writeAgentRunSummary.js"
import { writeIssueStateComment } from "./writeIssueStateComment.js"
import { writeJobStateFile } from "./writeJobStateFile.js"

export const preflightScripts: Record<string, PreflightScript> = {
  runFlow,
  fixFlow,
  fixCiFlow,
  resolveFlow,
  revertFlow,
  reviewFlow,
  syncFlow,
  mergeFlow,
  initFlow,
  loadTaskState,
  loadTaskContext,
  loadIssueContext,
  loadIssueStateComment,
  loadJobFromFile,
  loadCapabilityState,
  loadCompanyIntents,
  loadCompanyPortfolio,
  loadAgentAdhoc,
  loadConventions,
  loadCoverageRules,
  loadLinkedFinding,
  loadMemoryContext,
  loadPriorArt,
  loadQaContext,
  prepareBrowserAuth,
  buildSyntheticPlugin,
  resolveArtifacts,
  discoverQaContext,
  deriveQaScopeFromIssue,
  resolvePreviewUrl,
  resolveQaUrl,
  promoteQaGoal,
  composePrompt,
  setCommentTarget,
  setLifecycleLabel,
  skipAgent,
  classifyByLabel,
  diagMcp,
  warmupMcp,
  dispatchCapabilityTicks,
  dispatchCapabilityFileTicks,
  planTaskJobs,
  dispatchNextTaskJob,
  runScheduledImplementationTick,
  runScheduledExecutableTick: runScheduledImplementationTick,
  runTickScript,
  runPreviewBuild,
  advanceManagedGoal,
  loadGoalState,
  saveManagedGoalState,
}

export const postflightScripts: Record<string, PostflightScript> = {
  parseAgentResult,
  parseIssueStateFromAgentResult,
  parseJobStateFromAgentResult,
  parseReproOutput,
  validateAgencyModelProposal,
  writeIssueStateComment,
  writeJobStateFile,
  appendCompanyActivity,
  requireFeedbackActions,
  requireDeliveryArtifacts,
  requirePlanDeviations,
  verify,
  verifyWithRetry,
  verifyReproFails,
  checkCoverageWithRetry,
  abortUnfinishedGitOps,
  stageMergeConflicts,
  commitAndPush,
  ensurePr,
  evaluateAgencyBoundaries: evaluateAgencyBoundariesScript,
  postAgentComment,
  postIssueComment,
  postPlanComment,
  postResearchComment,
  postReviewResult,
  persistArtifacts,
  writeAgentRunSummary,
  saveTaskState,
  mirrorStateToPr,
  startFlow,
  dispatch,
  finishFlow,
  finalizeTerminal,
  advanceFlow,
  persistFlowState,
  applyCapabilityReports,
  publishReport,
  recordClassification,
  dispatchClassified,
  notifyTerminal,
  openAgencyModelReviewPr,
  openQaIssue,
  createQaGoal,
  failOnceTaskJob,
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
