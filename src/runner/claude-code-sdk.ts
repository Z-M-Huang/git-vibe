import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query, type EffortLevel, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunAiStageOptions } from "./ai.js";
import { logSdkWebPolicyNotice } from "./ai-web-policy.js";
import {
  isRecord,
  sdkModelName,
  sdkProfileEnv,
  strictOutputSchema,
  stringValue,
} from "./sdk-adapter-utils.js";
import { summarizeError, type StageLogger } from "./logging.js";
import { prepareSdkMcpConfig } from "./mcp-sdk-config.js";
import { structuredOutputText, validatedSdkOutput } from "./sdk-output.js";

const require = createRequire(import.meta.url);

export async function runClaudeCodeSdkStage({
  options,
  profile,
  profileName,
}: {
  options: RunAiStageOptions;
  profile: Record<string, unknown>;
  profileName: string;
}): Promise<string> {
  const model = sdkModelName(profile, "claude-code-sdk");
  const contextDir = mkdtempSync(join(tmpdir(), "git-vibe-claude-"));
  try {
    const mcpConfig = prepareSdkMcpConfig({ contextDir, options });
    const env = sdkProfileEnv(profile, `ai.profiles.${profileName}`);
    applyInstalledClaudeEnv(env);
    env.CLAUDE_AGENT_SDK_CLIENT_APP ??= "git-vibe";
    const executable = claudeCodeExecutablePath();

    options.logger?.event("ai.request.start", {
      adapter: "claude-code-sdk",
      max_turns: options.maxTurns,
      model,
      profile: profileName,
      provider: "claude-code-sdk",
    });
    logSdkPromptPreview(options.logger, options.stage, "system", options.system);
    logSdkPromptPreview(options.logger, options.stage, "user", options.prompt);
    logSdkWebPolicyNotice({
      adapter: "claude-code-sdk",
      config: options.config,
      logger: options.logger,
    });

    let result = "";
    let structuredOutput: unknown;
    let messageCount = 0;
    for await (const message of query({
      options: {
        ...(options.contextFilesRoot ? { additionalDirectories: [options.contextFilesRoot] } : {}),
        allowDangerouslySkipPermissions: true,
        allowedTools: mcpConfig.claudeAllowedTools,
        cwd: options.isolateWorkspace ? contextDir : options.cwd,
        effort: claudeEffort(profile),
        env,
        maxTurns: options.maxTurns,
        mcpServers: mcpConfig.claudeMcpServers,
        model,
        outputFormat: {
          schema: strictOutputSchema(options.schema),
          type: "json_schema",
        },
        pathToClaudeCodeExecutable: executable,
        permissionMode: "bypassPermissions",
        persistSession: false,
        strictMcpConfig: Object.keys(mcpConfig.claudeMcpServers).length > 0,
        systemPrompt: options.system,
        tools: options.isolateWorkspace ? [] : options.toolOverride,
      },
      prompt: options.prompt,
    })) {
      messageCount += 1;
      logClaudeSdkMessage(message, options.logger);
      if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Claude Code SDK failed: ${claudeResultErrorDetail(message)}`);
        }
        result = message.result;
        structuredOutput = message.structured_output;
      }
    }

    const content = structuredOutputText(structuredOutput) || result;
    const validated = await validatedSdkOutput({
      content,
      schema: options.schema,
      schemaId: options.schemaId,
    });
    options.logger?.event("ai.request.done", {
      adapter: "claude-code-sdk",
      output_chars: validated.length,
      profile: profileName,
      sdk_messages: messageCount,
    });
    return validated;
  } finally {
    rmSync(contextDir, { force: true, recursive: true });
  }
}

function claudeResultErrorDetail(message: Extract<SDKMessage, { type: "result" }>): string {
  const rawErrors = (message as { errors?: unknown }).errors;
  const errors = Array.isArray(rawErrors) ? rawErrors.filter(Boolean).map(String) : [];
  return errors.length > 0 ? errors.join("; ") : message.subtype;
}

function claudeEffort(profile: Record<string, unknown>): EffortLevel | undefined {
  const effort = stringValue((profile.reasoning as Record<string, unknown> | undefined)?.effort);
  if (!effort) return undefined;
  if (isClaudeEffort(effort)) return effort;
  throw new Error(`AI profile reasoning.effort is not supported by claude-code-sdk: ${effort}.`);
}

function applyInstalledClaudeEnv(env: NodeJS.ProcessEnv): void {
  const home = stringValue(process.env.HOME) || homedir();
  if (home) env.HOME = home;
  else delete env.HOME;

  const configDir = stringValue(process.env.CLAUDE_CONFIG_DIR);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
}

function isClaudeEffort(value: string): value is EffortLevel {
  return ["low", "medium", "high", "xhigh", "max"].includes(value);
}

function claudeCodeExecutablePath(): string {
  const configured = stringValue(process.env.GITVIBE_CLAUDE_CODE_PATH);
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`GITVIBE_CLAUDE_CODE_PATH does not exist: ${configured}`);
    }
    if (!isExecutable(configured)) {
      throw new Error(`GITVIBE_CLAUDE_CODE_PATH is not executable: ${configured}`);
    }
    return configured;
  }

  const packageName = claudeCodeNativePackageName();
  if (!packageName) {
    throw new Error(
      `claude-code-sdk executable resolution is not supported on ${process.platform}/${process.arch}. GitVibe actions support Linux and macOS runners.`,
    );
  }

  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const sdkRequire = createRequire(sdkEntry);
  const packageJson = sdkRequire.resolve(`${packageName}/package.json`);
  const executable = join(dirname(packageJson), "claude");
  if (!isExecutable(executable)) {
    throw new Error(`Resolved Claude Code executable is not executable: ${executable}`);
  }
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

function claudeCodeNativePackageName(): string | undefined {
  const os = claudeCodeNativeOs();
  const arch = claudeCodeNativeArch();
  if (!os || !arch) return undefined;
  const libc = os === "linux" && isMuslLinux() ? "-musl" : "";
  return `@anthropic-ai/claude-agent-sdk-${os}-${arch}${libc}`;
}

function claudeCodeNativeOs(): "darwin" | "linux" | undefined {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  return undefined;
}

function claudeCodeNativeArch(): "arm64" | "x64" | undefined {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return undefined;
}

function isMuslLinux(): boolean {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime;
}

function logClaudeSdkMessage(message: SDKMessage, logger: StageLogger | undefined): void {
  if (message.type === "assistant") {
    logClaudeAssistantMessage(message.message, logger);
    return;
  }
  if (message.type === "result") {
    logger?.event("ai.claude.result", {
      duration_ms: message.duration_ms,
      error: message.is_error === true || undefined,
      reason: message.terminal_reason || message.stop_reason,
      turns: message.num_turns,
    });
    return;
  }
  if (message.type === "system" && message.subtype === "init") {
    logger?.event("ai.claude.init", {
      model: message.model,
      permission: message.permissionMode,
      tools: message.tools.length,
      version: message.claude_code_version,
    });
    return;
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    logger?.event("ai.claude.compact", {
      duration_ms: message.compact_metadata.duration_ms,
      post_tokens: message.compact_metadata.post_tokens,
      pre_tokens: message.compact_metadata.pre_tokens,
      trigger: message.compact_metadata.trigger,
    });
    return;
  }
  if (message.type === "system" && message.subtype === "api_retry") {
    logger?.event("ai.claude.retry", {
      attempt: message.attempt,
      delay_ms: Math.round(Number(message.retry_delay_ms) || 0),
      error: message.error,
      status: message.error_status,
    });
  }
}

function logClaudeAssistantMessage(message: unknown, logger: StageLogger | undefined): void {
  const record = isRecord(message) ? message : {};
  const content = Array.isArray(record.content) ? record.content.filter(isRecord) : [];
  let emitted = false;
  for (const item of content) {
    const type = stringValue(item.type);
    if (type === "text") {
      logger?.event("ai.claude.message", { text: summarizeError(stringValue(item.text) || "") });
      emitted = true;
    }
    if (type === "thinking") {
      logger?.event("ai.claude.thinking", {
        chars: String(item.thinking || "").length,
      });
      emitted = true;
    }
    if (type === "tool_use") {
      logger?.event("ai.claude.tool", {
        input: summarizeToolInput(item.input),
        tool: stringValue(item.name) || "unknown",
      });
      emitted = true;
    }
  }
  if (!emitted) logger?.event("ai.claude.assistant", { items: content.length });
}

function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return "";
  const filePath = stringValue(input.file_path);
  if (filePath) return `file_path=${filePath}`;
  const command = stringValue(input.command);
  if (command) return `command=${summarizeError(command)}`;
  const keys = Object.keys(input);
  return keys.length > 0 ? `keys=${keys.slice(0, 5).join(",")}` : "";
}

function logSdkPromptPreview(
  logger: StageLogger | undefined,
  stage: string,
  label: string,
  text: string,
): void {
  logger?.event("ai.prompt", {
    chars: text.length,
    preview: summarizeError(text),
    prompt: label,
    stage,
  });
}
