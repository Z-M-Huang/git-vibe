import { writeStageResultFile, writeStageResultSummary } from "./handoffs.js";
import type { StageLogger } from "./logging.js";
import { renderStageResultComment } from "./result-comments.js";
import { matrixResultMetadata } from "./role-groups.js";
import { normalizeReviewMatrixOutput } from "./review-matrix-output.js";
import { loadStageSchema, validateOutput } from "./schemas.js";
import { stageDefinitions } from "../shared/stages.js";
import type { ContextPacket, RunnerOptions, StageRunResult } from "../shared/types.js";

export async function stageRunResult({
  content,
  context,
  definition,
  logger,
  options,
}: {
  content: string;
  context: ContextPacket;
  definition: (typeof stageDefinitions)[RunnerOptions["stage"]];
  logger: StageLogger;
  options: RunnerOptions;
}): Promise<StageRunResult> {
  logger.event("output.validation.start", { schema_id: definition.schemaId });
  const schema = loadStageSchema(definition.schemaFile);
  const validatedOutput = await validateOutput({ content, schema, schemaId: definition.schemaId });
  logger.event("output.validation.done", {
    status: String(validatedOutput.status),
  });
  const normalization =
    options.stage === "review-matrix"
      ? normalizeReviewMatrixOutput(validatedOutput)
      : {
          duplicateFindingIds: 0,
          output: validatedOutput,
          rewrittenInlineComments: 0,
        };
  const parsedOutput = normalization.output;
  if (normalization.duplicateFindingIds > 0) {
    logger.event("output.inline_comments.normalized", {
      duplicate_finding_ids: normalization.duplicateFindingIds,
      rewritten_inline_comments: normalization.rewrittenInlineComments,
    });
  }
  const result: StageRunResult = {
    commentBody: renderStageResultComment({
      context,
      parsedOutput,
      stage: options.stage,
      workflowRunUrl: options.workflowRunUrl,
    }),
    parsedOutput,
    schemaId: definition.schemaId,
    status: String(parsedOutput.status),
    summary: String(parsedOutput.summary),
    validationErrors: [],
  };
  const contextDir = process.env.RUNNER_TEMP || options.cwd;
  const metadata =
    options.executionMode === "member"
      ? matrixResultMetadata({
          profileName: options.profileName,
          result,
          roleName: options.roleName,
        })
      : undefined;
  result.resultFile = writeStageResultFile({
    directory: contextDir,
    metadata,
    result,
    stage: options.stage,
  });
  writeStageResultSummary({
    metadata,
    result,
    stage: options.stage,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
  logger.event("result.persisted", { file: `git-vibe-${options.stage}-result.json` });
  return result;
}
