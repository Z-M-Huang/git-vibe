import { runAiStage, type RunAiStageOptions } from "./ai.js";
import { zeroMatrixResultsOutput } from "./stage-blocked-outputs.js";
import { dryRunContent } from "./stage-dry-run.js";
import { stageRunResult } from "./stage-results.js";
import { promptInjectionBlockedResult } from "./safety-gate-runner.js";
import {
  loadMatrixStageResults,
  type MatrixStageResult,
  roleGroupSynthesisMembers,
  stageExecutionPlan,
  synthesisPromptAddition,
  synthesizerSystemPrompt,
} from "./role-groups.js";
import type { StageLogger } from "./logging.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  GitVibeConfig,
  JsonObject,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";

export async function runStageResultForMode(options: {
  acceptedRisk: boolean;
  aiRunOptions: RunAiStageOptions;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  executionMode: RunnerOptions["executionMode"];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  if (options.executionMode === "finalizer") {
    return runMatrixFinalizerResult(options);
  }
  return runStageAiResult(options);
}

async function runStageAiResult({
  aiRunOptions,
  context,
  definition,
  logger,
  options,
}: {
  aiRunOptions: RunAiStageOptions;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  const buildResult = stageResultBuilder({ context, definition, logger, options });
  if (options.dryRun) return buildResult(dryRunContent(options.stage, context, logger));

  return buildResult(await runAiStage(aiRunOptions));
}

async function runMatrixFinalizerResult({
  acceptedRisk,
  aiRunOptions,
  config,
  context,
  definition,
  logger,
  options,
}: {
  acceptedRisk: boolean;
  aiRunOptions: RunAiStageOptions;
  config: GitVibeConfig;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  const plan = stageExecutionPlan(config, options.stage, options.cwd);
  const results = loadMatrixStageResults(options.memberResultsDir, options.stage);
  const expected = plan.matrix.include.length;
  const failed = Math.max(0, expected - results.length);

  logger.event("matrix.finalize.start", {
    expected,
    failed,
    mode: plan.mode,
    successful: results.length,
  });
  if (results.length === 0) {
    return stageRunResult({
      content: JSON.stringify(zeroMatrixResultsOutput({ context, expected, options })),
      context,
      definition,
      logger,
      options,
    });
  }
  if (options.dryRun || plan.mode === "profile") {
    return stageRunResult({
      content: JSON.stringify(results[0]?.parsedOutput),
      context,
      definition,
      logger,
      options,
    });
  }

  const members = roleGroupSynthesisMembers(plan);
  const buildResult = stageResultBuilder({ context, definition, logger, options });
  const sanitizedResults = sanitizedMatrixMemberResults(results);
  const finalizerSafetySources = matrixFinalizerSafetySources({ results: sanitizedResults });
  const blocked = await promptInjectionBlockedResult({
    buildResult,
    config,
    context,
    extraSources: finalizerSafetySources,
    includeContext: !acceptedRisk,
    logger,
    phase: "input",
    runner: options,
  });
  if (blocked) return blocked;

  const prompt = synthesisPromptAddition({
    expected,
    failed,
    members,
    results: sanitizedResults,
    roleGroup: plan.roleGroup,
    stage: options.stage,
  });
  return stageRunResult({
    content: await runAiStage({
      ...aiRunOptions,
      contextFilesRoot: undefined,
      isolateWorkspace: true,
      profileName: plan.synthesizerProfile,
      prompt,
      system: synthesizerSystemPrompt(options.stage),
      toolOverride: [],
    }),
    context,
    definition,
    logger,
    options,
  });
}

function matrixFinalizerSafetySources(options: { results: MatrixStageResult[] }) {
  return options.results.map((result, index) => ({
    label: `matrix member result ${index + 1}`,
    text: JSON.stringify({
      output: result.parsedOutput,
      role: result.role,
      status: result.status,
      summary: result.summary,
    }),
  }));
}

function sanitizedMatrixMemberResults(results: MatrixStageResult[]): MatrixStageResult[] {
  return results.map((result) => {
    const safetyBlocked = isGitVibeSafetyBlockedOutput(result.parsedOutput);
    return {
      ...result,
      parsedOutput: sanitizedMatrixMemberSafetyValue(
        result.parsedOutput,
        [],
        safetyBlocked,
      ) as JsonObject,
      summary: sanitizedMatrixMemberText(result.summary, ["summary"], safetyBlocked),
    };
  });
}

function sanitizedMatrixMemberSafetyValue(
  value: unknown,
  path: string[],
  safetyBlocked: boolean,
): unknown {
  if (typeof value === "string") return sanitizedMatrixMemberText(value, path, safetyBlocked);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizedMatrixMemberSafetyValue(item, path, safetyBlocked));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, item]) => [
      key,
      sanitizedMatrixMemberSafetyValue(item, [...path, key], safetyBlocked),
    ]),
  );
}

function sanitizedMatrixMemberText(value: string, path: string[], safetyBlocked: boolean): string {
  if (path.includes("findings")) return value;
  const safetyBlockedField = safetyBlocked && gitVibeSafetyBlockedPath(path);
  if (gitVibeOwnedText(value)) {
    const patterns = [
      ...gitVibeOwnedLinePatterns,
      ...(safetyBlockedField ? gitVibeSafetyBlockedLinePatterns : []),
    ];
    return sanitizedGitVibeBoilerplate(value, patterns);
  }
  if (!safetyBlockedField) return value;
  return sanitizedGitVibeBoilerplate(value, gitVibeSafetyBlockedLinePatterns);
}

function sanitizedGitVibeBoilerplate(value: string, patterns: RegExp[]): string {
  return patterns
    .reduce((text, pattern) => text.replace(pattern, ""), value)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function gitVibeOwnedText(value: string): boolean {
  return (
    gitVibeMarkerPattern.test(value) ||
    /^## GitVibe Risk Accepted\s*$/m.test(value) ||
    /^### Accepted Risk\s*$/m.test(value)
  );
}

function gitVibeSafetyBlockedPath(path: string[]): boolean {
  const key = path.at(-1);
  return (
    key === "summary" ||
    key === "comment_body" ||
    key === "question" ||
    path.includes("questions") ||
    path.includes("blocking_questions")
  );
}

function isGitVibeSafetyBlockedOutput(output: JsonObject): boolean {
  return (
    output.status === "blocked" &&
    output.next_state === "blocked" &&
    output.summary === "GitVibe paused this run for maintainer review."
  );
}

const gitVibeMarkerPattern = new RegExp(String.raw`<!--\s*git-vibe:`, "i");

const gitVibeOwnedLinePatterns = [
  new RegExp(
    String.raw`\n*<!--\s*git-vibe:accepted-risk-metadata\s+[^>]*-->[\s\S]*?<!--\s*git-vibe:accepted-risk-end\s*-->\n*`,
    "g",
  ),
  new RegExp(String.raw`<!--\s*git-vibe:(?:stage-result|risk-accepted)\s+[^>]*-->`, "g"),
  /^## GitVibe Risk Accepted\s*$/gm,
  /^### Accepted Risk\s*$/gm,
  /^Accepted at: .*$/gm,
  /^Accepted workflow run: .*$/gm,
  /^Accepted workflow attempt: .*$/gm,
  /^Accepted stages: .*$/gm,
  /^Artifact title\/body SHA: .*$/gm,
  /^Pull request head SHA: .*$/gm,
  /GitVibe replaced the previous blocked result details to keep this thread readable\./g,
  /GitVibe removed `git-vibe:accept-risk`; future runs reuse this acceptance only while the accepted artifact context still matches, and new context is still scanned\./g,
  /(?:`[^`]+`|@[\w-]+) accepted (?:this )?prompt-injection input risk for matching (?:`[\w-]+` )?context\./g,
  /(?:`[^`]+`|@[\w-]+) accepted (?:this )?prompt-injection input risk for one `?[\w-]+`? (?:run|rerun)\./g,
];

const gitVibeSafetyBlockedLinePatterns = [
  /GitVibe paused this run for maintainer review\./g,
  /Change the flagged content or safety configuration, or apply `git-vibe:accept-risk` to accept this prompt-injection input risk for matching context\./g,
  /GitVibe treats issue bodies, comments, diffs, repository files, and future image\/OCR text as untrusted data\. A trusted maintainer must change the flagged content, adjust safety configuration, apply `git-vibe:accept-risk` for matching context, or handle the case manually before automation continues\./g,
];

function stageResultBuilder(options: {
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): (content: string) => Promise<StageRunResult> {
  return (content: string) =>
    stageRunResult({
      content,
      context: options.context,
      definition: options.definition,
      logger: options.logger,
      options: options.options,
    });
}
