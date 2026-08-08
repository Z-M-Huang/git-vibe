#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactLogText } from "../logging.js";
import { runStageSecurityReview } from "../stage-runner.js";
import { parseSourceComment } from "../../shared/source-comments.js";
import { parseStage } from "../../shared/stages.js";
import type { Stage } from "../../shared/types.js";
import { githubAppToken } from "./github-app-token.js";

export interface SecurityReviewRuntime {
  appendFile?: (path: string, content: string) => void;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  error?: (message: string) => void;
  fetch?: typeof fetch;
  githubToken?: () => Promise<string>;
  log?: (message: string) => void;
  runStageSecurityReview?: typeof runStageSecurityReview;
}

export async function securityReview(runtime: SecurityReviewRuntime = {}): Promise<number> {
  const env = runtime.env || process.env;
  const argv = runtime.argv || process.argv.slice(2);
  const log = runtime.log || ((message) => console.log(`[git-vibe] ${message}`));
  const error = runtime.error || ((message) => console.error(`[git-vibe] ${message}`));

  try {
    const stage = parseStage(argv[0] || envValue(env, "GITVIBE_STAGE"));
    const token = await resolveGitHubToken(runtime, env);
    const repository = requiredEnv(env, "GITHUB_REPOSITORY");
    const cwd = env.GITHUB_WORKSPACE || runtime.cwd || process.cwd();
    const target = readTargetInputs(stage, env);
    const reviewTargetSha = envValue(env, "GITVIBE_REVIEW_EVENT_TARGET_SHA") || undefined;
    const result = await (runtime.runStageSecurityReview || runStageSecurityReview)({
      cwd,
      dryRun: envValue(env, "GITVIBE_DRY_RUN").toLowerCase() === "true",
      handoffDir: envValue(env, "GITVIBE_HANDOFF_DIR") || undefined,
      issueNumber: target.issueNumber,
      maxTurns: 1,
      prNumber: target.prNumber,
      repository,
      ...(stage === "review-matrix" && reviewTargetSha
        ? { review: { targetSha: reviewTargetSha } }
        : {}),
      sourceComment: parseSourceComment(envValue(env, "GITVIBE_SOURCE_COMMENT")),
      stage,
      stageTimeoutMinutes: numberEnv(env, "GITVIBE_STAGE_TIMEOUT_MINUTES", 10),
      token,
      workflowRunAttempt: envValue(env, "GITHUB_RUN_ATTEMPT") || undefined,
      workflowRunUrl: workflowRunUrl(env),
    });

    log(`${stage} security-review status=${result.status}`);
    log(result.summary);
    writeOutputs(env, result, runtime.appendFile || appendFileSync);
    return 0;
  } catch (caught) {
    error(redactLogText(caught instanceof Error ? caught.message : String(caught)));
    return 1;
  }
}

function resolveGitHubToken(
  runtime: SecurityReviewRuntime,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return runtime.githubToken
    ? runtime.githubToken()
    : githubAppToken({
        env,
        fetch: runtime.fetch || fetch,
        permissionProfile: "runner-status-write",
      });
}

export function isDirectRun(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!moduleUrl) {
    return Boolean(entrypoint && /(?:^|[/\\])security-review\.(?:c?js|ts)$/.test(entrypoint));
  }
  return Boolean(entrypoint && moduleUrl === pathToFileURL(resolve(entrypoint)).href);
}

function readTargetInputs(
  stage: Stage,
  env: NodeJS.ProcessEnv,
): {
  issueNumber: string;
  prNumber: string;
} {
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

function workflowRunUrl(env: NodeJS.ProcessEnv): string | undefined {
  const repository = envValue(env, "GITHUB_REPOSITORY");
  const runId = envValue(env, "GITHUB_RUN_ID");
  if (!repository || !runId) return undefined;
  const serverUrl = envValue(env, "GITHUB_SERVER_URL") || "https://github.com";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function writeOutputs(
  env: NodeJS.ProcessEnv,
  result: Awaited<ReturnType<typeof runStageSecurityReview>>,
  appendFile: (path: string, content: string) => void,
): void {
  if (!env.GITHUB_OUTPUT) return;
  writeOutput(env.GITHUB_OUTPUT, "allowed", result.allowed ? "true" : "false", appendFile);
  writeOutput(env.GITHUB_OUTPUT, "summary", result.summary, appendFile);
  writeOutput(env.GITHUB_OUTPUT, "status", result.status, appendFile);
  if (result.allowed && result.inputSafetyDigest) {
    writeOutput(env.GITHUB_OUTPUT, "input-safety-digest", result.inputSafetyDigest, appendFile);
  }
  if (result.reviewScope) {
    writeOutput(env.GITHUB_OUTPUT, "base-sha", result.reviewScope.baseSha, appendFile);
    writeOutput(
      env.GITHUB_OUTPUT,
      "checkpoint-sha",
      result.reviewScope.checkpointSha || "",
      appendFile,
    );
    writeOutput(
      env.GITHUB_OUTPUT,
      "head-repository",
      result.reviewScope.headRepository,
      appendFile,
    );
    writeOutput(env.GITHUB_OUTPUT, "snapshot-sha", result.reviewScope.snapshotSha, appendFile);
    writeOutput(env.GITHUB_OUTPUT, "target-sha", result.reviewScope.targetSha, appendFile);
  }
  if (result.result?.resultFile) {
    writeOutput(env.GITHUB_OUTPUT, "result-file", result.result.resultFile, appendFile);
  }
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

if (isDirectRun("", process.argv[1])) {
  securityReview().then((code) => {
    process.exit(code);
  });
}
