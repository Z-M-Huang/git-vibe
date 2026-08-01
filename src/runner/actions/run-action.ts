#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { runStage } from "../stage-runner.js";
import { isInvestigationReady } from "../stage-publishing.js";
import { redactLogText } from "../logging.js";
import { matrixMemberRowForStage } from "../role-groups.js";
import { parseSourceComment } from "../../shared/source-comments.js";
import { parseStage } from "../../shared/stages.js";
import type { GitHubActionsRunnerPermissionProfile } from "../../shared/github-app-permissions.js";
import type { ReviewRunState, RunnerOptions, Stage, StageRunResult } from "../../shared/types.js";
import { githubAppToken, runnerPermissionProfileForStage } from "./github-app-token.js";

export interface ActionRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  fetch?: typeof fetch;
  githubToken?: () => Promise<string>;
  log?: (message: string) => void;
  runStage?: typeof runStage;
}

export async function runAction(runtime: ActionRuntime = {}): Promise<number> {
  const env = runtime.env || process.env;
  const argv = runtime.argv || process.argv.slice(2);
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const stage = parseStage(argv[0]);
    const executionMode = executionModeEnv(env);
    const failOnBlocked = booleanEnv(env, "GITVIBE_FAIL_ON_BLOCKED", false);
    const failOnChangesRequired = booleanEnv(env, "GITVIBE_FAIL_ON_CHANGES_REQUIRED", false);
    const token = await resolveGitHubToken(
      runtime,
      env,
      runnerPermissionProfileForStage(stage, executionMode),
    );
    const repository = requiredEnv(env, "GITHUB_REPOSITORY");
    const cwd = env.GITHUB_WORKSPACE || runtime.cwd || process.cwd();
    const target = readTargetInputs(stage, env);
    const maxTurns = numberEnv(env, "GITVIBE_MAX_TURNS", 90);
    const memberResultsDir = memberResultsDirFor({ cwd, env, executionMode, stage });
    const profileSelection = executionProfileSelection({
      cwd,
      env,
      executionMode,
      stage,
    });
    const result = await (runtime.runStage || runStage)({
      cwd,
      dryRun: envValue(env, "GITVIBE_DRY_RUN").toLowerCase() === "true",
      executionMode,
      failOnNotReady: envValue(env, "GITVIBE_FAIL_ON_NOT_READY").toLowerCase() === "true",
      handoffDir: envValue(env, "GITVIBE_HANDOFF_DIR") || undefined,
      issueNumber: target.issueNumber,
      memberResultsDir,
      maxTurns,
      prNumber: target.prNumber,
      profileName: profileSelection.profileName,
      repository,
      review: reviewRunOptions(stage, env),
      roleName: profileSelection.roleName,
      sourceComment: parseSourceComment(envValue(env, "GITVIBE_SOURCE_COMMENT")),
      stage,
      stageTimeoutMinutes: numberEnv(env, "GITVIBE_STAGE_TIMEOUT_MINUTES", 60),
      token,
      workflowRunAttempt: envValue(env, "GITHUB_RUN_ATTEMPT") || undefined,
      workflowRunUrl: workflowRunUrl(env),
    });

    log(`${stage} status=${result.status}`);
    log(result.summary);
    writeOutputs(env, result, runtime.appendFile || appendFileSync);
    if (shouldFailOnStatus(failOnBlocked, result.status)) {
      error(`${stage} returned status ${result.status}; stopping workflow.`);
      return 1;
    }
    if (shouldFailOnInvestigationReadiness(env, stage, result)) {
      error("investigate is not ready for implementation; stopping workflow.");
      return 1;
    }
    if (shouldFailOnReviewChangesRequired(failOnChangesRequired, stage, executionMode, result)) {
      error("review-matrix returned next_state changes-required; stopping workflow.");
      return 1;
    }
    return 0;
  } catch (caught) {
    error(redactLogText(caught instanceof Error ? caught.message : String(caught)));
    return 1;
  }
}

function resolveGitHubToken(
  runtime: ActionRuntime,
  env: NodeJS.ProcessEnv,
  permissionProfile: GitHubActionsRunnerPermissionProfile,
): Promise<string> {
  return runtime.githubToken
    ? runtime.githubToken()
    : githubAppToken({ env, fetch: runtime.fetch || fetch, permissionProfile });
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl)
    return Boolean(entrypoint && /(?:^|[/\\])run-action\.(?:c?js|ts)$/.test(entrypoint));
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

function readTargetInputs(
  stage: ReturnType<typeof parseStage>,
  env: NodeJS.ProcessEnv,
): { issueNumber: string; prNumber: string } {
  const discussionNumber = envValue(env, "GITVIBE_DISCUSSION_NUMBER");
  const issueNumber = envValue(env, "GITVIBE_ISSUE_NUMBER");
  const prNumber = envValue(env, "GITVIBE_PR_NUMBER");

  if (stage === "investigate" && !issueNumber && !prNumber) {
    throw new Error("GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for investigate.");
  }
  if (stage === "materialize" && !discussionNumber) {
    throw new Error("GITVIBE_DISCUSSION_NUMBER is required for this stage.");
  }
  if (stage === "validate" && !issueNumber && !discussionNumber) {
    throw new Error("GITVIBE_ISSUE_NUMBER or GITVIBE_DISCUSSION_NUMBER is required for validate.");
  }
  if (stage === "review-matrix" && !issueNumber && !prNumber) {
    throw new Error("GITVIBE_ISSUE_NUMBER or GITVIBE_PR_NUMBER is required for review-matrix.");
  }
  if (
    !["investigate", "review-matrix", "materialize", "validate"].includes(stage) &&
    !issueNumber
  ) {
    throw new Error("GITVIBE_ISSUE_NUMBER is required for this stage.");
  }

  return { issueNumber, prNumber };
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const rawValue = envValue(env, name);
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function optionalIntegerEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const rawValue = envValue(env, name);
  if (!rawValue) return undefined;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function executionModeEnv(env: NodeJS.ProcessEnv): RunnerOptions["executionMode"] {
  const value = envValue(env, "GITVIBE_EXECUTION_MODE") || "standard";
  if (value === "standard" || value === "member" || value === "finalizer") {
    return value;
  }
  throw new Error("GITVIBE_EXECUTION_MODE must be standard, member, or finalizer.");
}

function reviewRunOptions(stage: Stage, env: NodeJS.ProcessEnv): ReviewRunState | undefined {
  if (stage !== "review-matrix") return undefined;
  return {
    baseSha: envValue(env, "GITVIBE_REVIEW_BASE_SHA") || undefined,
    checkpointSha: envValue(env, "GITVIBE_REVIEW_CHECKPOINT_SHA") || undefined,
    inputSafetyDigest: envValue(env, "GITVIBE_INPUT_SAFETY_DIGEST") || undefined,
    snapshotSha: envValue(env, "GITVIBE_REVIEW_SNAPSHOT_SHA") || undefined,
    targetSha: envValue(env, "GITVIBE_REVIEW_TARGET_SHA") || undefined,
  };
}

function executionProfileSelection(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executionMode: RunnerOptions["executionMode"];
  stage: Stage;
}): { profileName?: string; roleName?: string } {
  const profileName = envValue(options.env, "GITVIBE_PROFILE_NAME") || undefined;
  const roleName = envValue(options.env, "GITVIBE_ROLE_NAME") || undefined;
  if (options.executionMode !== "member" || profileName) return { profileName, roleName };

  const memberIndex = optionalIntegerEnv(options.env, "GITVIBE_MEMBER_INDEX");
  if (memberIndex === undefined) {
    throw new Error(
      "GITVIBE_PROFILE_NAME or GITVIBE_MEMBER_INDEX is required for member execution.",
    );
  }
  const row = matrixMemberRowForStage(
    loadConfig(options.cwd),
    options.stage,
    options.cwd,
    memberIndex,
  );
  return { profileName: row.profile, roleName: row.role || undefined };
}

function memberResultsDirFor(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executionMode: RunnerOptions["executionMode"];
  stage: Stage;
}): string | undefined {
  if (options.executionMode !== "finalizer") return undefined;
  return join(options.env.RUNNER_TEMP || options.cwd, `git-vibe-${options.stage}-members`);
}

function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const repository = envValue(env, "GITHUB_REPOSITORY");
  const runId = envValue(env, "GITHUB_RUN_ID");
  if (!repository || !runId) return undefined;
  const serverUrl = envValue(env, "GITHUB_SERVER_URL") || "https://github.com";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function writeOutputs(
  env: NodeJS.ProcessEnv,
  result: StageRunResult,
  appendFile: (path: string, content: string) => void,
): void {
  if (!env.GITHUB_OUTPUT) return;
  writeOutput(env.GITHUB_OUTPUT, "summary", result.summary, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "status", result.status, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "comment-body", result.commentBody, appendFile);
  const nextState = stringOutput(result.parsedOutput.next_state);
  if (nextState) writeOutput(env.GITHUB_OUTPUT, "next-state", nextState, appendFile);
  if (result.schemaId === "investigate.v1") {
    writeOutput(
      env.GITHUB_OUTPUT,
      "ready-for-implementation",
      isInvestigationReady(result.parsedOutput) ? "true" : "false",
      appendFile,
    );
  }
  if (result.resultFile)
    writeOutput(env.GITHUB_OUTPUT, "result-file", result.resultFile, appendFile);
}

function shouldFailOnStatus(failOnBlocked: boolean, status: string): boolean {
  return failOnBlocked && status !== "completed";
}

function shouldFailOnInvestigationReadiness(
  env: NodeJS.ProcessEnv,
  stage: ReturnType<typeof parseStage>,
  result: StageRunResult,
): boolean {
  return (
    stage === "investigate" &&
    envValue(env, "GITVIBE_FAIL_ON_NOT_READY").toLowerCase() === "true" &&
    !isInvestigationReady(result.parsedOutput)
  );
}

function shouldFailOnReviewChangesRequired(
  failOnChangesRequired: boolean,
  stage: ReturnType<typeof parseStage>,
  executionMode: RunnerOptions["executionMode"],
  result: StageRunResult,
): boolean {
  return (
    stage === "review-matrix" &&
    executionMode === "finalizer" &&
    failOnChangesRequired &&
    stringOutput(result.parsedOutput.next_state) === "changes-required"
  );
}

function writeOutput(
  outputPath: string,
  name: string,
  value: string,
  appendFile: (path: string, content: string) => void,
): void {
  appendFile(outputPath, `${name}<<GITVIBE_OUTPUT\n${value}\nGITVIBE_OUTPUT\n`);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = envValue(env, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] || "";
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = envValue(env, name).trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function stringOutput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

if (isDirectRun("", process.argv[1])) {
  runAction().then((code) => {
    process.exit(code);
  });
}
