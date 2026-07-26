// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAiStage } from "../src/runner/ai.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_BASE_URL: "https://codex-proxy.example/v1",
      GITVIBE_AI_API_KEY: "test-key",
    }),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("SDK MCP config", () => {
  it("passes stage MCP gateway config to Codex SDK", async () => {
    const cwd = workspace();
    process.env.GITHUB_ACTION_PATH = join(cwd, "action");
    process.env.GITVIBE_MCP_ENV_JSON = JSON.stringify({ DENSE_TOKEN: "secret-token" });
    let gatewayContent;
    globalThis.__gitVibeSdkMocks.codexRun.mockImplementationOnce(async () => {
      const constructorOptions = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[0][0];
      const gatewayPath =
        constructorOptions.config.mcp_servers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
      gatewayContent = JSON.parse(readFileSync(gatewayPath, "utf8"));
      return {
        finalResponse: JSON.stringify(validValidateOutput()),
        items: [],
        usage: {},
      };
    });
    await runAiStage(stageOptions({ cwd, config: codexConfigWithMcp() }));

    const constructorOptions = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[0][0];
    expect(constructorOptions.config.features?.plugins).toBe(false);
    expect(constructorOptions.config.model_provider).toBe("openai");
    expect(constructorOptions.config.mcp_servers.dense_mem).toMatchObject({
      args: [join(cwd, "dist/actions/mcp-gateway.js")],
      command: process.execPath,
      enabled: true,
      enabled_tools: ["search_memory"],
      required: true,
      tools: { search_memory: { approval_mode: "approve" } },
    });
    const gatewayPath =
      constructorOptions.config.mcp_servers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
    expect(gatewayContent).toMatchObject({
      allowTools: ["search_memory"],
      required: true,
      server: {
        args: ["server.js"],
        command: "node",
        name: "dense_mem",
        transport: "stdio",
      },
    });
    expect(existsSync(gatewayPath)).toBe(false);
  });

  it("passes stage MCP gateway config to Claude SDK", async () => {
    const cwd = workspace();
    process.env.GITVIBE_AI_ENV_JSON = JSON.stringify({
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      GITVIBE_AI_API_KEY: "test-key",
    });
    process.env.GITVIBE_MCP_ENV_JSON = JSON.stringify({ DENSE_TOKEN: "secret-token" });
    let gatewayContent;
    globalThis.__gitVibeSdkMocks.claudeQuery.mockImplementationOnce(async function* (params) {
      const gatewayPath = params.options.mcpServers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
      gatewayContent = JSON.parse(readFileSync(gatewayPath, "utf8"));
      yield {
        duration_ms: 1,
        is_error: false,
        num_turns: 1,
        result: JSON.stringify(validValidateOutput()),
        stop_reason: "stop",
        structured_output: validValidateOutput(),
        subtype: "success",
        type: "result",
      };
    });
    await runAiStage(stageOptions({ cwd, config: claudeConfigWithMcp() }));

    const queryOptions = globalThis.__gitVibeSdkMocks.claudeQuery.mock.calls[0][0].options;
    expect(queryOptions.allowedTools).toEqual(["mcp__dense_mem__search_memory"]);
    expect(queryOptions.strictMcpConfig).toBe(true);
    expect(queryOptions.mcpServers.dense_mem).toMatchObject({
      alwaysLoad: true,
      command: process.execPath,
      type: "stdio",
    });
    const gatewayPath = queryOptions.mcpServers.dense_mem.env.GITVIBE_MCP_GATEWAY_CONFIG;
    expect(gatewayContent).toMatchObject({
      allowTools: ["search_memory"],
      required: true,
    });
    expect(existsSync(gatewayPath)).toBe(false);
  });
});

describe("SDK MCP config warnings", () => {
  it("warns and leaves SDK MCP config empty for optional unresolved model servers", async () => {
    const cwd = workspace();
    const logger = { event: vi.fn() };
    await runAiStage(stageOptions({ config: optionalBrokenMcpConfig(), cwd, logger }));

    expect(globalThis.__gitVibeSdkMocks.codexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { features: { plugins: false }, model_provider: "openai" },
      }),
    );
    expect(logger.event).toHaveBeenCalledWith("mcp.sdk_config.warning", {
      reason: "ai.mcp.servers.dense_mem.command must be configured for stdio MCP servers.",
      server: "dense_mem",
    });
  });
});

function stageOptions({ config, cwd, logger }) {
  return {
    config,
    cwd,
    logger,
    maxTurns: 3,
    prompt: "Prompt",
    schema: validateSchema(),
    schemaId: "validate.v1",
    stage: "validate",
    stageDefinition: { schemaFile: "validate.v1.schema.json", schemaId: "validate.v1" },
    system: "System",
  };
}

function codexConfig(overrides = {}) {
  return {
    ai: {
      profiles: {
        test: {
          api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
          adapter: "codex-sdk",
          base_url: { from_bundle: "CODEX_BASE_URL" },
          model: "gpt-5-test",
          reasoning: { effort: "high" },
          ...overrides,
        },
      },
      stages: { validate: { profile: "test" } },
    },
  };
}

function claudeConfig(overrides = {}) {
  return {
    ai: {
      profiles: {
        test: {
          adapter: "claude-code-sdk",
          env: {
            ANTHROPIC_API_KEY: { from_bundle: "GITVIBE_AI_API_KEY" },
            ANTHROPIC_BASE_URL: { from_bundle: "ANTHROPIC_BASE_URL" },
          },
          model: "opus",
          reasoning: { effort: "max" },
          ...overrides,
        },
      },
      stages: { validate: { profile: "test" } },
    },
  };
}

function codexConfigWithMcp() {
  return withMcp(codexConfig());
}

function claudeConfigWithMcp() {
  return withMcp(claudeConfig());
}

function withMcp(config) {
  return {
    ai: {
      ...config.ai,
      mcp: {
        servers: {
          dense_mem: {
            args: ["server.js"],
            command: "node",
            env: { DENSE_TOKEN: { from_bundle: "DENSE_TOKEN" } },
            transport: "stdio",
          },
        },
      },
      stages: {
        validate: {
          mcp: {
            dense_mem: {
              required: true,
              tools: ["search_memory"],
            },
          },
          profile: "test",
        },
      },
    },
  };
}

function optionalBrokenMcpConfig() {
  const config = codexConfig();
  return {
    ai: {
      ...config.ai,
      mcp: {
        servers: {
          dense_mem: {
            transport: "stdio",
          },
        },
      },
      stages: {
        validate: {
          mcp: {
            dense_mem: {
              required: false,
              tools: ["search_memory"],
            },
          },
          profile: "test",
        },
      },
    },
  };
}

function validateSchema() {
  return JSON.parse(
    readFileSync(join(process.cwd(), "schemas/stages/validate.v1.schema.json"), "utf8"),
  );
}

function validValidateOutput(overrides = {}) {
  return {
    assumptions: [],
    comment_body: "Ready.",
    findings: [],
    next_state: "ready-for-implementation",
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Ready.",
    ...overrides,
  };
}

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-sdk-mcp-config-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), "version: 1\n");
  return cwd;
}
