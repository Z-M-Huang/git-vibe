import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { CodexOptions } from "@openai/codex-sdk";
import type { RunAiStageOptions } from "./ai.js";
import { modelMcpServersForStage } from "./mcp-config.js";
import { namespacedToolName } from "./mcp-tool-names.js";

export interface SdkMcpConfig {
  claudeAllowedTools: string[];
  claudeMcpServers: Record<string, McpServerConfig>;
  codexConfig: NonNullable<CodexOptions["config"]>;
}

interface GatewayFile {
  path: string;
  required: boolean;
  serverName: string;
  tools: string[];
}

export function prepareSdkMcpConfig(options: {
  contextDir: string;
  options: RunAiStageOptions;
}): SdkMcpConfig {
  if (options.options.toolOverride) return emptySdkMcpConfig();

  const stageServers = modelMcpServersForStage({
    config: options.options.config,
    stage: options.options.stage,
  });
  if (stageServers.length === 0) return emptySdkMcpConfig();

  const gatewayDir = join(options.contextDir, "mcp-gateway");
  mkdirSync(gatewayDir, { recursive: true });
  const files = stageServers.flatMap((stageServer) => {
    if (!stageServer.server) {
      options.options.logger?.event("mcp.sdk_config.warning", {
        reason: stageServer.resolutionError,
        server: stageServer.name,
      });
      return [];
    }
    const path = join(gatewayDir, `${stageServer.name}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          allowTools: stageServer.allowModelTools,
          required: stageServer.required,
          server: stageServer.server,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return [
      {
        path,
        required: stageServer.required,
        serverName: stageServer.name,
        tools: stageServer.allowModelTools,
      },
    ];
  });
  if (files.length === 0) return emptySdkMcpConfig();

  options.options.logger?.event("mcp.sdk_config.ready", {
    servers: files.map((file) => file.serverName).join(","),
  });
  return {
    claudeAllowedTools: claudeAllowedTools(files),
    claudeMcpServers: claudeMcpServers(files),
    codexConfig: codexMcpConfig(files),
  };
}

function emptySdkMcpConfig(): SdkMcpConfig {
  return { claudeAllowedTools: [], claudeMcpServers: {}, codexConfig: {} };
}

function claudeMcpServers(files: GatewayFile[]): Record<string, McpServerConfig> {
  return Object.fromEntries(
    files.map((file) => [
      file.serverName,
      {
        alwaysLoad: true,
        args: [gatewayScriptPath()],
        command: process.execPath,
        env: { GITVIBE_MCP_GATEWAY_CONFIG: file.path },
        type: "stdio",
      },
    ]),
  );
}

function claudeAllowedTools(files: GatewayFile[]): string[] {
  return files.flatMap((file) =>
    file.tools.map((tool) => namespacedToolName(file.serverName, tool)),
  );
}

function codexMcpConfig(files: GatewayFile[]): NonNullable<CodexOptions["config"]> {
  return {
    mcp_servers: Object.fromEntries(
      files.map((file) => [
        file.serverName,
        {
          args: [gatewayScriptPath()],
          command: process.execPath,
          enabled: true,
          enabled_tools: file.tools,
          env: { GITVIBE_MCP_GATEWAY_CONFIG: file.path },
          required: file.required,
          tools: Object.fromEntries(file.tools.map((tool) => [tool, { approval_mode: "approve" }])),
        },
      ]),
    ),
  };
}

function gatewayScriptPath(): string {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (actionPath) return resolve(actionPath, "..", "dist", "actions", "mcp-gateway.js");
  return resolve(process.cwd(), "dist", "actions", "mcp-gateway.js");
}
