import {
  activeProfileByName,
  adapterName,
  profileNamesForStage,
  stageConfigFor,
} from "./ai-config.js";
import { extractValidatedOutput } from "./ai-output.js";
import { systemWithWebPolicy } from "./ai-web-policy.js";
import { runClaudeCodeSdkStage } from "./claude-code-sdk.js";
import { runCodexSdkStage } from "./codex-sdk.js";
import type { StageLogger } from "./logging.js";
import { systemWithProfileContext } from "./profile-context.js";
import type { GitVibeConfig, JsonObject, Stage, StageDefinition } from "../shared/types.js";

export { extractValidatedOutput };

export interface RunAiStageOptions {
  config: GitVibeConfig;
  contextFilesRoot?: string;
  cwd: string;
  isolateWorkspace?: boolean;
  maxTurns: number;
  prompt: string;
  profileContextCwd?: string;
  schema: JsonObject;
  schemaId: string;
  stage: Stage;
  stageDefinition: StageDefinition;
  system: string;
  profileName?: string;
  reserveFinalizationTurns?: boolean;
  sandboxMode?: "danger-full-access" | "read-only" | "workspace-write";
  toolOverride?: string[];
  logger?: StageLogger;
}

export async function runAiStage(options: RunAiStageOptions): Promise<string> {
  validateStageConfig(options);
  const profileName = options.profileName || profileNamesForStage(options.config, options.stage)[0];
  return runAiStageWithProfile(options, profileName);
}

async function runAiStageWithProfile(
  options: RunAiStageOptions,
  profileName: string,
): Promise<string> {
  const profile = activeProfileByName(options.config, profileName);
  const adapter = adapterName(profile, `ai.profiles.${profileName}`);
  const system = systemWithProfileContext({
    cwd: options.profileContextCwd || options.cwd,
    profile,
    profileName,
    system: options.system,
  });
  const profileOptions = {
    ...options,
    system: systemWithWebPolicy({ config: options.config, system }),
  };

  if (adapter === "codex-sdk") {
    return runCodexSdkStage({
      options: profileOptions,
      profile,
      profileName,
    });
  }

  if (adapter === "claude-code-sdk") {
    return runClaudeCodeSdkStage({
      options: profileOptions,
      profile,
      profileName,
    });
  }

  throw new Error(`AI profile ${profileName} uses unsupported adapter ${adapter}.`);
}

function validateStageConfig(options: RunAiStageOptions): void {
  const stageConfig = stageConfigFor(options.config, options.stage);
  if (stageConfig.enabled === false) {
    throw new Error(`ai.stages.${options.stage} is disabled.`);
  }
  if (stageConfig.enabled !== undefined && typeof stageConfig.enabled !== "boolean") {
    throw new Error(`ai.stages.${options.stage}.enabled must be a boolean.`);
  }
}
