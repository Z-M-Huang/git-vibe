import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { activeProfileByName, adapterName, stageConfigFor, stringValue } from "./ai-config.js";
import type { GitVibeConfig, JsonObject, Stage, StageRunResult } from "../shared/types.js";

export interface StageMatrixRow {
  artifact: string;
  index: number;
  model: string;
  profile: string;
  role: string;
}

export interface StageWorkflowMatrixRow {
  artifact: string;
  index: number;
}

export interface StageExecutionPlan {
  matrix: { include: StageMatrixRow[] };
  maxParallel: number;
  mode: "profile" | "role-group";
  roleGroup?: string;
  synthesizerProfile?: string;
}

export interface MatrixStageResult {
  parsedOutput: JsonObject;
  profile: string;
  role: string;
  schemaId: string;
  stage: Stage;
  status: string;
  summary: string;
}

export interface RoleGroupSynthesisMember {
  artifact: string;
  index: number;
  profile: string;
  role: string;
}

const roleGroupStages = new Set<Stage>(["investigate", "review-matrix", "validate"]);
const writeOrPublishStages = new Set<Stage>(["materialize"]);

export function stageExecutionPlan(
  config: GitVibeConfig,
  stage: Stage,
  cwd = process.cwd(),
): StageExecutionPlan {
  const stageConfig = stageConfigFor(config, stage);
  rejectProfiles(stageConfig, stage);
  const profile = stringValue(stageConfig.profile);
  const roleGroup = stringValue(stageConfig.role_group);

  if (profile && roleGroup) {
    throw new Error(`ai.stages.${stage} cannot define both profile and role_group.`);
  }
  if (profile) {
    const activeProfile = activeProfileByName(config, profile);
    return {
      matrix: { include: [matrixRow(stage, 0, profile, "", profileModelName(activeProfile))] },
      maxParallel: 1,
      mode: "profile",
    };
  }
  if (!roleGroup) throw new Error(`ai.stages.${stage} must define profile or role_group.`);
  if (!roleGroupStages.has(stage) || writeOrPublishStages.has(stage)) {
    throw new Error(`ai.stages.${stage}.role_group is only supported for read-only stages.`);
  }

  const group = roleGroupConfig(config, roleGroup);
  return {
    matrix: {
      include: group.roles.map((role, index) => {
        assertRoleFile(cwd, role.role);
        const activeProfile = activeProfileByName(config, role.profile);
        return matrixRow(stage, index, role.profile, role.role, profileModelName(activeProfile));
      }),
    },
    maxParallel: group.parallel,
    mode: "role-group",
    roleGroup,
    synthesizerProfile: group.synthesizer,
  };
}

export function profileNamesForConfiguredStage(
  config: GitVibeConfig,
  stage: Stage,
  cwd = process.cwd(),
): string[] {
  const plan = stageExecutionPlan(config, stage, cwd);
  const names = plan.matrix.include.map((row) => row.profile);
  if (plan.synthesizerProfile) names.push(plan.synthesizerProfile);
  return [...new Set(names)];
}

export function stageWorkflowMatrix(plan: StageExecutionPlan): {
  include: StageWorkflowMatrixRow[];
} {
  return {
    include: plan.matrix.include.map((row) => ({
      artifact: row.artifact,
      index: row.index,
    })),
  };
}

export function stageWorkflowIndexes(plan: StageExecutionPlan): number[] {
  return plan.matrix.include.map((row) => row.index);
}

export function stageWorkflowLabels(plan: StageExecutionPlan): Record<string, string> {
  return Object.fromEntries(
    plan.matrix.include.map((row) => [
      String(row.index),
      `${workflowRoleLabel(row.role)} - ${row.profile}`,
    ]),
  );
}

export function stageWorkflowAdapters(
  config: GitVibeConfig,
  plan: StageExecutionPlan,
): Record<string, string> {
  return Object.fromEntries(
    plan.matrix.include.map((row) => [
      String(row.index),
      profileAdapter(config, row.profile, `ai.profiles.${row.profile}`),
    ]),
  );
}

export function stageFinalizerAdapter(config: GitVibeConfig, plan: StageExecutionPlan): string {
  const profile = plan.synthesizerProfile || plan.matrix.include[0]?.profile;
  if (!profile) throw new Error("Stage execution plan must include a finalizer profile.");
  return profileAdapter(config, profile, `ai.profiles.${profile}`);
}

export function stageSafetyAdapter(config: GitVibeConfig, plan: StageExecutionPlan): string {
  if (config.safety?.prompt_injection_gate === false) return "";
  return stageFinalizerAdapter(config, plan);
}

function workflowRoleLabel(role: string): string {
  if (!role) return "default";
  return basename(role).replace(/\.[^.]+$/, "") || "default";
}

export function matrixMemberRowForStage(
  config: GitVibeConfig,
  stage: Stage,
  cwd: string,
  index: number,
): StageMatrixRow {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("GITVIBE_MEMBER_INDEX must be a non-negative integer.");
  }
  const plan = stageExecutionPlan(config, stage, cwd);
  const row = plan.matrix.include.find((candidate) => candidate.index === index);
  if (!row) throw new Error(`GITVIBE_MEMBER_INDEX ${index} is not configured for ${stage}.`);
  return row;
}

export function singleProfileNamesForStage(config: GitVibeConfig, stage: Stage): string[] {
  const stageConfig = stageConfigFor(config, stage);
  rejectProfiles(stageConfig, stage);
  if (stageConfig.role_group !== undefined) {
    throw new Error(`ai.stages.${stage}.role_group requires matrix workflow execution.`);
  }
  const profile = stringValue(stageConfig.profile);
  if (!profile) throw new Error(`ai.stages.${stage} must define profile or role_group.`);
  return [profile];
}

export function readRoleDefinition(cwd: string, role: string): string {
  const path = assertRoleFile(cwd, role);
  const content = readFileSync(path, "utf8").trim();
  if (!content) throw new Error(`Role definition must not be empty: ${role}`);
  return content;
}

export function roleGroupSynthesisMembers(plan: StageExecutionPlan): RoleGroupSynthesisMember[] {
  return plan.matrix.include.map((member) => ({
    artifact: member.artifact,
    index: member.index,
    profile: member.profile,
    role: member.role,
  }));
}

export function loadMatrixStageResults(
  directory: string | undefined,
  stage: Stage,
): MatrixStageResult[] {
  if (!directory) return [];
  try {
    return resultFiles(directory)
      .map((file) => parseMatrixStageResult(readFileSync(file, "utf8"), stage))
      .filter((result): result is MatrixStageResult => Boolean(result));
  } catch {
    return [];
  }
}

export function matrixResultMetadata(options: {
  profileName?: string;
  result: StageRunResult;
  roleName?: string;
}): JsonObject {
  return {
    profile: options.profileName || "",
    role: options.roleName || "",
    schemaId: options.result.schemaId,
    status: options.result.status,
    summary: options.result.summary,
  };
}

export function synthesisPromptAddition(options: {
  expected: number;
  failed: number;
  members?: RoleGroupSynthesisMember[];
  results: MatrixStageResult[];
  roleGroup?: string;
  stage: Stage;
}): string {
  return `<role_group_results>
${JSON.stringify(
  {
    expected_results: options.expected,
    failed_results: options.failed,
    configured_members: (options.members || []).map((member) => ({
      artifact: member.artifact,
      index: member.index,
      profile: member.profile,
      role: member.role,
    })),
    results: options.results.map((result) => ({
      output: result.parsedOutput,
      profile: result.profile,
      role: result.role,
      status: result.status,
      summary: result.summary,
    })),
    role_group: options.roleGroup || "",
    stage: options.stage,
    successful_results: options.results.length,
  },
  null,
  2,
)}
</role_group_results>`;
}

export function synthesizerSystemPrompt(stage: Stage): string {
  const lines = [
    "<role_group_synthesizer>",
    "You combine multiple GitVibe role results into one final stage result.",
    "Build every output field from the member results.",
    "Preserve every distinct member finding.",
    "Merge findings only when they describe the same underlying issue, combining their evidence, references, tests, severity, and inline comment details.",
    "Mention role success and failure counts in summary or comment_body when any role result is missing.",
  ];
  if (stage === "review-matrix") {
    lines.push(
      "Every inline_comments finding_id must be unique in the final output.",
      "When one finding needs multiple anchors, use one ranged comment when possible or assign each anchor a distinct stable finding_id.",
    );
  }
  return [
    ...lines,
    "Return one JSON object matching the existing stage schema.",
    "</role_group_synthesizer>",
  ].join("\n");
}

function roleGroupConfig(
  config: GitVibeConfig,
  name: string,
): {
  parallel: number;
  roles: { profile: string; role: string }[];
  synthesizer: string;
} {
  const groups = config.ai?.role_groups;
  if (!isRecord(groups)) throw new Error("ai.role_groups must be an object.");
  const group = groups[name];
  if (!isRecord(group)) throw new Error(`ai.role_groups.${name} must be an object.`);
  const synthesizer = stringValue(group.synthesizer);
  if (!synthesizer) throw new Error(`ai.role_groups.${name}.synthesizer must be configured.`);
  activeProfileByName(config, synthesizer);

  const roles = parseRoles(group.roles, `ai.role_groups.${name}.roles`);
  const parallel = positiveInteger(group.parallel, `ai.role_groups.${name}.parallel`, 1);
  if (roles.length > 256)
    throw new Error(`ai.role_groups.${name}.roles cannot exceed 256 entries.`);
  return { parallel, roles, synthesizer };
}

function parseRoles(value: unknown, path: string): { profile: string; role: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array of role/profile objects.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${path}[${index}] must be an object.`);
    const role = stringValue(entry.role);
    const profile = stringValue(entry.profile);
    if (!role || !profile) throw new Error(`${path}[${index}] must define role and profile.`);
    validateRoleFilename(role, `${path}[${index}].role`);
    return { profile, role };
  });
}

function rejectProfiles(stageConfig: Record<string, unknown>, stage: Stage): void {
  if (stageConfig.profiles !== undefined) {
    throw new Error(
      `ai.stages.${stage}.profiles is no longer supported; use profile or role_group.`,
    );
  }
  if (stageConfig.fallback_profile !== undefined) {
    throw new Error(
      `ai.stages.${stage}.fallback_profile is no longer supported; use profile or role_group.`,
    );
  }
}

function matrixRow(
  stage: Stage,
  index: number,
  profile: string,
  role: string,
  model: string,
): StageMatrixRow {
  return {
    artifact: `git-vibe-${stage}-member-${index}`,
    index,
    model,
    profile,
    role,
  };
}

function profileModelName(profile: Record<string, unknown>): string {
  const provider = profile.provider;
  if (isRecord(provider)) {
    const providerModel = stringValue(provider.model);
    if (providerModel) return providerModel;
  }
  return stringValue(profile.model) || "";
}

function profileAdapter(config: GitVibeConfig, profile: string, path: string): string {
  return adapterName(activeProfileByName(config, profile), path);
}

function assertRoleFile(cwd: string, role: string): string {
  validateRoleFilename(role, "role");
  const path = join(cwd, ".git-vibe", "role-group", role);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Role definition must be a regular file: ${role}`);
  }
  const realCwd = realpathSync(cwd);
  const realPath = realpathSync(path);
  if (!isPathInside(realPath, realCwd)) {
    throw new Error(`Role definition must stay inside the workspace: ${role}`);
  }
  return path;
}

function validateRoleFilename(value: string, path: string): void {
  if (basename(value) !== value || value === "." || value === ".." || !value.endsWith(".md")) {
    throw new Error(`${path} must be a markdown filename in .git-vibe/role-group/.`);
  }
}

function resultFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return resultFiles(path);
    return /^git-vibe-[a-z-]+-result\.json$/.test(entry.name) ? [path] : [];
  });
}

function parseMatrixStageResult(content: string, stage: Stage): MatrixStageResult | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || parsed.stage !== stage || !isRecord(parsed.parsedOutput)) {
      return undefined;
    }
    return {
      parsedOutput: parsed.parsedOutput,
      profile: stringValue(parsed.profile) || "",
      role: stringValue(parsed.role) || "",
      schemaId: stringValue(parsed.schemaId) || `${stage}.v1`,
      stage,
      status: stringValue(parsed.status) || "completed",
      summary: stringValue(parsed.summary) || `${stage} completed.`,
    };
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return value;
}

function isPathInside(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
