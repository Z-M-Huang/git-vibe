import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { RunAiStageOptions } from "./ai.js";
import { logSdkWebPolicyNotice } from "./ai-web-policy.js";
import { codexOutputSchema, isRecord, sdkModelName, stringValue } from "./sdk-adapter-utils.js";
import { codexAuthOptions, prepareCodexEnv } from "./codex-auth.js";
import { summarizeError } from "./logging.js";
import { prepareSdkMcpConfig } from "./mcp-sdk-config.js";
import { validatedSdkOutput } from "./sdk-output.js";

const codexNativePackages: Record<string, { packageName: string; targetTriple: string }> = {
  "darwin:arm64": {
    packageName: "@openai/codex-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
  "darwin:x64": {
    packageName: "@openai/codex-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
  },
  "linux:arm64": {
    packageName: "@openai/codex-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "linux:x64": {
    packageName: "@openai/codex-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
  },
};

export async function runCodexSdkStage({
  options,
  profile,
  profileName,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Promise<string> {
  const model = sdkModelName(profile, "codex-sdk");
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-codex-"));
  try {
    const mcpConfig = prepareSdkMcpConfig({ contextDir, options });
    const codexEnv = prepareCodexEnv({
      codexHome: join(contextDir, "codex-home"),
      profile,
      profileName,
    });
    const sdk = new Codex({
      ...codexAuthOptions(codexEnv),
      codexPathOverride: codexExecutablePath(),
      config: codexConfig(profile, mcpConfig.codexConfig, options.isolateWorkspace),
      env: stringEnv(codexEnv.env),
    });

    options.logger?.event("ai.request.start", {
      adapter: "codex-sdk",
      max_turns: options.maxTurns,
      model,
      profile: profileName,
      provider: "codex-sdk",
    });
    logSdkWebPolicyNotice({
      adapter: "codex-sdk",
      config: options.config,
      logger: options.logger,
    });

    const thread = sdk.startThread({
      ...(options.contextFilesRoot ? { additionalDirectories: [options.contextFilesRoot] } : {}),
      approvalPolicy: "never",
      model,
      modelReasoningEffort: codexReasoningEffort(profile),
      ...(options.isolateWorkspace
        ? { networkAccessEnabled: false, webSearchMode: "disabled" as const }
        : {}),
      sandboxMode: options.isolateWorkspace
        ? "read-only"
        : options.sandboxMode || "danger-full-access",
      skipGitRepoCheck: true,
      workingDirectory: options.isolateWorkspace ? contextDir : options.cwd,
    });
    const result = await thread.run(codexPrompt(options), {
      outputSchema: codexOutputSchema(options.schema),
    });
    for (const item of result.items) logCodexItem(item, options.logger);
    const validated = await validatedSdkOutput({
      content: result.finalResponse,
      schema: options.schema,
      schemaId: options.schemaId,
    });
    options.logger?.event("ai.request.done", {
      adapter: "codex-sdk",
      input_tokens: result.usage?.input_tokens,
      output_chars: validated.length,
      output_tokens: result.usage?.output_tokens,
      profile: profileName,
    });
    return validated;
  } finally {
    rmSync(contextDir, { force: true, recursive: true });
  }
}

function codexConfig(
  profile: Record<string, unknown>,
  mcpConfig: NonNullable<CodexOptions["config"]>,
  isolateWorkspace = false,
): NonNullable<CodexOptions["config"]> {
  const reasoning = profile.reasoning as Record<string, unknown> | undefined;
  const summary = stringValue(reasoning?.summary);
  return {
    model_provider: "openai",
    ...mcpConfig,
    ...(isolateWorkspace
      ? {
          features: {
            apps: false,
            browser_use: false,
            browser_use_external: false,
            computer_use: false,
            image_generation: false,
            in_app_browser: false,
            multi_agent: false,
            plugins: false,
            shell_tool: false,
            unified_exec: false,
          },
        }
      : {}),
    ...(summary ? { model_reasoning_summary: summary } : {}),
  };
}

function codexReasoningEffort(profile: Record<string, unknown>): ModelReasoningEffort | undefined {
  const effort = stringValue((profile.reasoning as Record<string, unknown> | undefined)?.effort);
  if (!effort) return undefined;
  if (isCodexReasoningEffort(effort)) return effort;
  throw new Error(`AI profile reasoning.effort is not supported by codex-sdk: ${effort}.`);
}

function isCodexReasoningEffort(value: string): value is ModelReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function codexExecutablePath(): string {
  const configured = stringValue(process.env.GITVIBE_CODEX_PATH);
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`GITVIBE_CODEX_PATH does not exist: ${configured}`);
    }
    if (!isExecutable(configured)) {
      throw new Error(`GITVIBE_CODEX_PATH is not executable: ${configured}`);
    }
    return configured;
  }

  const native = codexNativePackage();
  if (!native) {
    throw new Error(
      `codex-sdk executable resolution is not supported on ${process.platform}/${process.arch}. GitVibe actions support Linux and macOS runners.`,
    );
  }

  const sdkEntry = import.meta.resolve("@openai/codex-sdk");
  const sdkRequire = createRequire(sdkEntry);
  const codexPackageJson = sdkRequire.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackageJson);
  const packageJson = codexRequire.resolve(`${native.packageName}/package.json`);
  const executable = join(dirname(packageJson), "vendor", native.targetTriple, "bin", "codex");
  accessSync(executable, constants.X_OK);
  return executable;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function codexNativePackage(): { packageName: string; targetTriple: string } | undefined {
  return codexNativePackages[`${process.platform}:${process.arch}`];
}

function codexPrompt(options: RunAiStageOptions): string {
  return `${options.system}\n\n${options.prompt}`;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function logCodexItem(item: ThreadItem, logger: RunAiStageOptions["logger"]): void {
  if (item.type === "command_execution") {
    logger?.event("ai.codex.command", {
      command: summarizeError(item.command),
      exit_code: item.exit_code,
      status: item.status,
    });
    return;
  }
  if (item.type === "mcp_tool_call") {
    logger?.event("ai.codex.mcp_tool", {
      error: item.error?.message ? summarizeError(item.error.message) : undefined,
      server: item.server,
      status: item.status,
      tool: item.tool,
    });
    return;
  }
  if (item.type === "agent_message") {
    logger?.event("ai.codex.message", { text: summarizeError(item.text) });
    return;
  }
  if (item.type === "reasoning") {
    logger?.event("ai.codex.reasoning", { chars: item.text.length });
    return;
  }
  if (item.type === "file_change") {
    logger?.event("ai.codex.file_change", {
      changes: item.changes.length,
      status: item.status,
    });
    return;
  }
  if (item.type === "error") {
    logger?.event("ai.codex.error", { error: summarizeError(item.message) });
    return;
  }
  if (isRecord(item) && typeof item.type === "string") {
    logger?.event("ai.codex.item", { type: item.type });
  }
}
