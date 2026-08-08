import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAiStageOptions } from "./ai.js";
import { loadConfig } from "./config.js";
import { contextForStage } from "./context.js";
import { GitHubClient } from "../shared/github.js";
import { withStageHandoffs } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { createStageLogger } from "./logging.js";
import { buildMcpPromptContext } from "./mcp-context.js";
import { renderPrompts } from "./prompts.js";
import { contextWithoutIgnoredAuthors, safetyIgnoredAuthors } from "./ignored-authors.js";
import {
  contextPromptCoverageForContext,
  type ContextPromptCoverage,
  type PackedPromptContextFiles,
} from "./content-units.js";
import { writePromptContextFiles } from "./context-files.js";
import { runStageResultForMode } from "./stage-ai-results.js";
import { stageRunResult } from "./stage-results.js";
import { readRoleDefinition } from "./role-groups.js";
import { loadStageSchema } from "./schemas.js";
import type { SafetySource } from "./safety-gate.js";
import { blockUnsafePromptInjection } from "./safety-gate-runner.js";
import {
  acceptedRiskApplies,
  acceptedRiskContextUnits,
  acceptedRiskLabelPresent,
  contextWithoutAcceptedRiskMetadataSource,
  publishAcceptedRiskAudit,
  publishAcceptedRiskAuditForLabeledContext,
  runnerWithAcceptedRiskFromContext,
} from "./accepted-risk.js";
import {
  applyStageLabelTransition,
  applyStageStartLabelTransition,
  type PublishedArtifactComment,
  publishStageResultComment,
  publishStageStartComment,
} from "./stage-publishing.js";
import { stageContract } from "./stage-dry-run.js";
import { repositoryContext } from "./stage-git.js";
import { applyDeterministicWrites } from "./stage-writes.js";
import {
  reuseReviewInputSafetyAttestation,
  securityReviewResultWithAttestation,
  type StageSecurityReviewResult,
} from "./review-safety-attestation.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

type RunnerStageDefinition = (typeof stageDefinitions)[RunnerOptions["stage"]];
type StageSafetyOptions = Omit<
  Parameters<typeof blockUnsafePromptInjection>[0],
  "extraSources" | "phase" | "result"
>;
type StageAiPreparation =
  | { aiRunOptions: RunAiStageOptions; status: "ready" }
  | { result: StageRunResult; status: "blocked" };

export async function runStageSecurityReview(
  options: RunnerOptions,
): Promise<StageSecurityReviewResult> {
  const logger = createStageLogger(options.stage);
  logger.event("security.review.start", {
    dry_run: options.dryRun,
    repository: options.repository,
  });

  const config = loadConfig(options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  const context = await loadRunnerContext({ client, definition, logger, options });
  const runner = runnerWithAcceptedRiskFromContext({ context, logger, runner: options });
  const acceptedRisk = acceptedRiskApplies({ context, logger, runner });
  await applySecurityReviewStartLabelTransition({ client, context, logger, options: runner });
  const transientComments: PublishedArtifactComment[] = [];
  const safetyOptions = stageSafetyOptions({
    client,
    config,
    context,
    definition,
    logger,
    options: runner,
    transientComments,
  });
  if (acceptedRisk) {
    return securityReviewResultWithAttestation({
      config,
      context,
      result: await acceptedRiskSecurityReview(safetyOptions, {
        publishAudit:
          Boolean(options.acceptedRisk) ||
          acceptedRiskLabelPresent(context) ||
          Boolean(runner.acceptedRisk?.run),
      }),
    });
  }

  const inputSafetyResult = await blockPromptInput(safetyOptions);
  if (inputSafetyResult) {
    return securityReviewResultWithAttestation({
      config,
      context,
      result: blockedSecurityReview(inputSafetyResult),
    });
  }
  logger.event("security.review.done", { allowed: true });
  return securityReviewResultWithAttestation({
    config,
    context,
    result: { allowed: true, status: "allowed", summary: "Security review passed." },
  });
}

export async function runStage(options: RunnerOptions): Promise<StageRunResult> {
  const logger = createStageLogger(options.stage);
  const executionMode = options.executionMode || "standard";
  logger.event("stage.start", {
    dry_run: options.dryRun,
    execution_mode: executionMode,
    max_turns: options.maxTurns,
    repository: options.repository,
  });

  const config = loadConfig(options.cwd);
  const definition = stageDefinitions[options.stage];
  const client = new GitHubClient();
  const context = await loadRunnerContext({ client, definition, logger, options });
  const runner = runnerWithAcceptedRiskFromContext({ context, logger, runner: options });
  const transientComments = await publishStageStart({ client, context, logger, options: runner });
  const stageContext = { client, context, definition, logger, options: runner, transientComments };

  const safetyOptions = stageSafetyOptions({ ...stageContext, config });
  const ignoredAuthors = safetyIgnoredAuthors(config);
  const acceptedRisk = acceptedRiskApplies({ context, logger, runner });
  const promptContext = contextWithoutIgnoredAuthors(
    acceptedRisk ? contextWithoutAcceptedRiskMetadataSource(context, runner) : context,
    ignoredAuthors,
  );
  const inputSafetyResult = await blockInitialPromptInput({
    acceptedRisk,
    safetyOptions,
  });
  if (inputSafetyResult) return inputSafetyResult;

  const prepared = await prepareStageAi({
    client,
    config,
    context: promptContext,
    definition,
    executionMode,
    ignoredAuthors,
    logger,
    options,
    safetyOptions,
    transientComments,
  });
  if (prepared.status === "blocked") return finishStage(logger, prepared.result);

  const result = await runCheckedStageResult({
    ...stageContext,
    acceptedRisk,
    aiRunOptions: prepared.aiRunOptions,
    config,
    executionMode,
    safetyOptions,
  });
  await publishAcceptedRiskAuditForLabeledContext({ ...safetyOptions, acceptedRisk, result });
  return finishStage(logger, result);
}

async function prepareStageAi(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  executionMode: RunnerOptions["executionMode"];
  ignoredAuthors: readonly string[];
  logger: StageLogger;
  options: RunnerOptions;
  safetyOptions: StageSafetyOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageAiPreparation> {
  const schema = loadStageSchema(options.definition.schemaFile);
  if (options.executionMode === "finalizer") {
    options.logger.event("prompt.ready", {
      schema_id: options.definition.schemaId,
      tools: "",
    });
    return {
      aiRunOptions: buildFinalizerAiRunOptions({ ...options, schema }),
      status: "ready",
    };
  }

  const mcpContext = await resolveMcpContext(options);
  if (mcpContext.blockedResult) {
    return { result: mcpContext.blockedResult, status: "blocked" };
  }
  const contextFiles = persistContext(options);
  const prompts = buildRenderedPrompts({ ...options, contextFiles, schema });
  if (mcpContext.promptAddition) {
    prompts.prompt = `${prompts.prompt}\n\n${mcpContext.promptAddition}`;
  }
  options.logger.event("prompt.ready", {
    schema_id: options.definition.schemaId,
    tools: options.definition.tools.join(","),
  });

  const promptSafetyResult = await blockMcpPromptInput({
    promptAddition: mcpContext.promptAddition,
    safetyOptions: options.safetyOptions,
  });
  if (promptSafetyResult) return { result: promptSafetyResult, status: "blocked" };
  return {
    aiRunOptions: buildAiRunOptions({ ...options, contextFiles, prompts, schema }),
    status: "ready",
  };
}

async function blockInitialPromptInput(options: {
  acceptedRisk: boolean;
  safetyOptions: StageSafetyOptions;
}): Promise<StageRunResult | undefined> {
  if (reuseReviewInputSafetyAttestation(options.safetyOptions)) return undefined;
  if (options.acceptedRisk) return blockAcceptedRiskDeltaInput(options.safetyOptions);
  return blockPromptInput(options.safetyOptions);
}

async function blockAcceptedRiskDeltaInput(
  options: StageSafetyOptions,
): Promise<StageRunResult | undefined> {
  const contextUnits = acceptedRiskContextUnits(
    options.context,
    options.runner,
    safetyIgnoredAuthors(options.config),
  );
  if (contextUnits.length === 0) {
    options.logger.event("accepted_risk.input_gate.skip", {
      cutoff: options.runner.acceptedRisk?.cutoff,
      reason: "no-context-after-cutoff",
      stage: options.runner.stage,
    });
    return undefined;
  }
  options.logger.event("accepted_risk.input_gate.delta", {
    cutoff: options.runner.acceptedRisk?.cutoff,
    sources: contextUnits.length,
    stage: options.runner.stage,
  });
  return blockUnsafePromptInjection({
    ...options,
    contextUnits,
    phase: "input",
  });
}

function blockMcpPromptInput(options: {
  promptAddition: string;
  safetyOptions: StageSafetyOptions;
}): Promise<StageRunResult | undefined> {
  return blockUnsafePromptInjection({
    ...options.safetyOptions,
    extraSources: mcpPromptSafetySources(options.promptAddition),
    includeContext: false,
    phase: "input",
  });
}

const mcpPromptSafetySources = (promptAddition: string): SafetySource[] =>
  promptAddition ? [{ label: "rendered MCP context prompt addition", text: promptAddition }] : [];
async function runCheckedStageResult(options: {
  acceptedRisk: boolean;
  aiRunOptions: RunAiStageOptions;
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  executionMode: RunnerOptions["executionMode"];
  logger: StageLogger;
  options: RunnerOptions;
  safetyOptions: StageSafetyOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult> {
  const result = await runStageResultForMode(options);
  if (options.executionMode === "finalizer") {
    options.logger.event("context.coverage.skip", {
      reason: "matrix-finalizer-member-results-only",
    });
  } else {
    recordContextCoverage({
      coverage: contextPromptCoverageForContext(options.context, {
        budgetChars: Number.MAX_SAFE_INTEGER,
        ignoredAuthors: safetyIgnoredAuthors(options.config),
      }),
      logger: options.logger,
    });
  }
  if (options.executionMode === "member") return result;

  const outputSafetyResult = await blockUnsafePromptInjection({
    ...options.safetyOptions,
    includeContext: !options.acceptedRisk,
    phase: "output",
    result,
  });
  if (outputSafetyResult) return outputSafetyResult;

  return applyDeterministicWrites({
    client: options.client,
    context: options.context,
    logger: options.logger,
    options: options.options,
    result,
    transientComments: options.transientComments,
  });
}

function blockedSecurityReview(result: StageRunResult): StageSecurityReviewResult {
  return { allowed: false, result, status: result.status, summary: result.summary };
}

async function acceptedRiskSecurityReview(
  options: StageSafetyOptions,
  audit: { publishAudit: boolean } = { publishAudit: true },
): Promise<StageSecurityReviewResult> {
  const blockedResult = await blockAcceptedRiskDeltaInput(options);
  if (blockedResult) return blockedSecurityReview(blockedResult);
  if (audit.publishAudit) {
    await publishAcceptedRiskAudit(options);
  } else {
    options.logger.event("accepted_risk.audit.skip", { reason: "prior-accepted-risk" });
  }
  options.logger.event("security.review.done", {
    accepted_risk: true,
    allowed: true,
  });
  return {
    allowed: true,
    status: "allowed",
    summary: audit.publishAudit
      ? "Security review passed; accepted-risk label was removed."
      : "Security review passed.",
  };
}

function finishStage(logger: StageLogger, result: StageRunResult): StageRunResult {
  logger.event("stage.done", { status: result.status });
  return result;
}

async function resolveMcpContext(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): Promise<{ blockedResult?: StageRunResult; promptAddition: string }> {
  const mcpContext = await buildMcpPromptContext({
    config: options.config,
    context: options.context,
    logger: options.logger,
    runner: options.options,
  });
  if (!mcpContext.blocked) return { promptAddition: mcpContext.promptAddition };

  const blockedResult = await publishPreAiBlockedResult({
    client: options.client,
    context: options.context,
    definition: options.definition,
    logger: options.logger,
    options: options.options,
    output: mcpContext.blocked,
    transientComments: options.transientComments,
  });
  return { blockedResult, promptAddition: "" };
}

function recordContextCoverage(options: {
  coverage: ContextPromptCoverage;
  logger: StageLogger;
}): void {
  options.logger.event("context.coverage.checked", {
    complete: options.coverage.complete,
    file_backed: true,
    included_chunks: options.coverage.includedChunkIds.length,
    pending_chunks: options.coverage.pendingChunkIds.length,
    total_chunks: options.coverage.totalChunks,
  });
}

function persistContext(options: {
  context: ContextPacket;
  ignoredAuthors: readonly string[];
  logger: StageLogger;
  options: RunnerOptions;
}): PackedPromptContextFiles {
  const baseTempDir = process.env.RUNNER_TEMP || tmpdir();
  const contextDir = mkdtempSync(join(baseTempDir, `git-vibe-${options.options.stage}-`));
  writeFileSync(
    join(contextDir, `git-vibe-${options.options.stage}-context.json`),
    JSON.stringify(options.context, null, 2),
  );
  const contextFiles = writePromptContextFiles({
    context: options.context,
    ignoredAuthors: options.ignoredAuthors,
    rootDir: contextDir,
    stage: options.options.stage,
  });
  options.logger.event("context.persisted", {
    file: `git-vibe-${options.options.stage}-context.json`,
    index: contextFiles.index.path,
    index_chars: contextFiles.index.chars,
    manifest: contextFiles.manifest.path,
    units: contextFiles.units.length,
  });
  return contextFiles;
}

function buildAiRunOptions(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  contextFiles: PackedPromptContextFiles;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  prompts: { prompt: string; system: string };
  schema: JsonObject;
}): RunAiStageOptions {
  return {
    config: options.config,
    contextFilesRoot: options.contextFiles.root_dir,
    cwd: reviewWorkspace(options.options),
    logger: options.logger,
    maxTurns: options.options.maxTurns,
    profileName: options.options.profileName,
    profileContextCwd: options.options.cwd,
    prompt: options.prompts.prompt,
    sandboxMode: options.options.stage === "review-matrix" ? "read-only" : undefined,
    schema: options.schema,
    schemaId: options.definition.schemaId,
    stage: options.options.stage,
    stageDefinition: options.definition,
    system: options.prompts.system,
    toolOverride:
      options.options.stage === "review-matrix" && options.options.executionMode === "member"
        ? ["Read", "Glob", "Grep"]
        : undefined,
  };
}

function buildFinalizerAiRunOptions(options: {
  config: GitVibeConfig;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  schema: JsonObject;
}): RunAiStageOptions {
  return {
    config: options.config,
    cwd: options.options.cwd,
    logger: options.logger,
    maxTurns: options.options.maxTurns,
    profileName: options.options.profileName,
    prompt: "",
    schema: options.schema,
    schemaId: options.definition.schemaId,
    stage: options.options.stage,
    stageDefinition: options.definition,
    system: "",
  };
}

async function loadRunnerContext(options: {
  client: GitHubClient;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<ContextPacket> {
  const prContext =
    (options.options.stage === "review-matrix" || options.options.stage === "investigate") &&
    options.options.prNumber;
  options.logger.event("context.load.start", {
    issue_number: options.options.issueNumber,
    pr_number: options.options.prNumber,
    resolved_target: prContext ? "pull-request" : options.definition.target,
    target: options.definition.target,
  });
  const context = withStageHandoffs(
    withSourceComment(await contextForStage(options.client, options.options), options.options),
    options.options.handoffDir,
  );
  options.logger.event("context.load.done", {
    artifact: `${context.artifact.type}#${context.artifact.number}`,
    handoffs: context.handoffs?.length || 0,
    review_checkpoint: context.reviewScope?.checkpointSha || "",
    review_target: context.reviewScope?.targetSha || "",
    timeline_items: context.timeline.length,
  });
  return context;
}

async function publishStageStart(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<PublishedArtifactComment[]> {
  const transientComments: PublishedArtifactComment[] = [];
  if (options.options.executionMode === "member") return transientComments;
  if (!options.options.dryRun && options.options.workflowRunUrl) {
    const comment = await publishStageStartComment({
      client: options.client,
      context: options.context,
      logger: options.logger,
      runner: options.options,
    });
    if (comment) transientComments.push(comment);
  }
  if (!options.options.dryRun) {
    await applyStageStartLabelTransition({
      client: options.client,
      context: options.context,
      logger: options.logger,
      runner: options.options,
    });
  }
  return transientComments;
}

async function applySecurityReviewStartLabelTransition(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<void> {
  if (options.options.dryRun) return;
  if (options.options.stage !== "review-matrix") return;
  if (options.context.artifact.type !== "pull-request") return;
  await applyStageStartLabelTransition({
    client: options.client,
    context: options.context,
    logger: options.logger,
    runner: options.options,
  });
}

function roleDefinitionFor(options: RunnerOptions): string | undefined {
  if (options.executionMode !== "member" || !options.roleName) return undefined;
  return readRoleDefinition(options.cwd, options.roleName);
}

function buildRenderedPrompts(options: {
  context: ContextPacket;
  contextFiles: PackedPromptContextFiles;
  definition: RunnerStageDefinition;
  options: RunnerOptions;
  schema: JsonObject;
}): { prompt: string; system: string } {
  const workspace = reviewWorkspace(options.options);
  const expectedHead =
    workspace === options.options.cwd ? undefined : options.context.reviewScope?.targetSha;
  return renderPrompts({
    context: options.context,
    contextFiles: options.contextFiles,
    cwd: options.options.cwd,
    outputSchema: options.schema,
    promptDir: options.definition.promptDir,
    repositoryContext: repositoryContext(workspace, expectedHead),
    roleDefinition: roleDefinitionFor(options.options),
    stageContract: stageContract(options.options.stage, options.context),
  });
}

function reviewWorkspace(options: RunnerOptions): string {
  return options.stage === "review-matrix" &&
    options.executionMode === "member" &&
    options.review?.snapshotSha
    ? join(options.cwd, ".git-vibe", "review-snapshot")
    : options.cwd;
}

function blockPromptInput(
  options: StageSafetyOptions,
  extraSources?: SafetySource[],
): Promise<StageRunResult | undefined> {
  return blockUnsafePromptInjection({ ...options, extraSources, phase: "input" });
}

function stageSafetyOptions(options: {
  client: GitHubClient;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: RunnerStageDefinition;
  logger: StageLogger;
  options: RunnerOptions;
  transientComments: PublishedArtifactComment[];
}): StageSafetyOptions {
  return {
    buildResult: (content: string) =>
      stageRunResult({
        content,
        context: options.context,
        definition: options.definition,
        logger: options.logger,
        options: options.options,
      }),
    client: options.client,
    config: options.config,
    context: options.context,
    logger: options.logger,
    runner: options.options,
    transientComments: options.transientComments,
  };
}

async function publishPreAiBlockedResult(options: {
  client: GitHubClient;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
  output: JsonObject;
  transientComments: PublishedArtifactComment[];
}): Promise<StageRunResult> {
  const result = await stageRunResult({
    content: JSON.stringify(options.output),
    context: options.context,
    definition: options.definition,
    logger: options.logger,
    options: options.options,
  });
  if (options.options.executionMode === "member" || options.options.dryRun) return result;
  await publishStageResultComment({
    client: options.client,
    context: options.context,
    logger: options.logger,
    parsedOutput: result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  await applyStageLabelTransition({
    client: options.client,
    context: options.context,
    logger: options.logger,
    parsedOutput: result.parsedOutput,
    runner: options.options,
    transientComments: options.transientComments,
  });
  return result;
}

function withSourceComment(context: ContextPacket, options: RunnerOptions): ContextPacket {
  if (!options.sourceComment) return context;
  return { ...context, source: { ...(context.source || {}), comment: options.sourceComment } };
}
