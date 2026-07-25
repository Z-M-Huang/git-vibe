// @ts-nocheck
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStageResultForMode } from "../src/runner/stage-ai-results.ts";
import { loadStageSchema } from "../src/runner/schemas.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    GITVIBE_AI_ENV_JSON: JSON.stringify({
      CODEX_BASE_URL: "https://codex-proxy.example/v1",
      GITVIBE_AI_API_KEY: "test-key",
    }),
    RUNNER_TEMP: mkdtempSync(join(tmpdir(), "git-vibe-runner-")),
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("matrix finalizer safety sources", () => {
  it("safety-scans member outputs while synthesis omits role definitions and stage context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-finalizer-safety-"));
    const resultsDir = join(cwd, "member-results");
    const roleDefinition = [
      "Review the change for markhuang.ai behavioral correctness.",
      "Respect the repository's verification scope.",
      "Return only the current stage schema.",
    ].join("\n");
    writeRole(cwd, "security.md", roleDefinition);
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-validate-result.json"), memberResult());
    const config = roleGroupConfig();
    const definition = stageDefinitions.validate;
    globalThis.__gitVibeSdkMocks.queueCodexOutput(allowedSafetyOutput());
    globalThis.__gitVibeSdkMocks.queueCodexOutput(synthesizedOutput());

    const result = await runStageResultForMode({
      acceptedRisk: false,
      aiRunOptions: {
        config,
        cwd,
        maxTurns: 2,
        prompt: "base prompt",
        schema: loadStageSchema(definition.schemaFile),
        schemaId: definition.schemaId,
        stage: "validate",
        stageDefinition: definition,
        system: "system prompt",
      },
      config,
      context: contextPacket(),
      definition,
      executionMode: "finalizer",
      logger: { event: vi.fn() },
      options: runnerOptions(cwd, resultsDir),
    });

    expect(result.summary).toBe("Synthesized.");
    const calls = globalThis.__gitVibeSdkMocks.codexRun.mock.calls.map(([input, turnOptions]) => ({
      input: String(input),
      schemaId: turnOptions.outputSchema?.$id,
    }));
    expect(calls.map((call) => call.schemaId)).toEqual(["safety-gate.v1", "validate.v1"]);

    const safetyPrompt = safetyPromptJson(calls[0].input);
    expect(safetyPrompt.sources.map((source) => source.label)).toContain("matrix member result 1");
    expect(safetyPrompt.sources.map((source) => source.label).join("\n")).not.toContain(
      "role-group security.md definition",
    );
    expect(JSON.stringify(safetyPrompt)).not.toContain(roleDefinition);

    expect(calls[1].input).not.toContain("role_definition");
    expect(calls[1].input).not.toContain("Review the change for markhuang.ai");
    expect(calls[1].input).not.toContain("base prompt");
    expect(calls[1].input).not.toContain("system prompt");
    const synthesisThread = globalThis.__gitVibeSdkMocks.codexStartThread.mock.calls[1][0];
    expect(synthesisThread).toMatchObject({
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      webSearchMode: "disabled",
    });
    expect(synthesisThread.workingDirectory).not.toBe(cwd);
    expect(synthesisThread.workingDirectory).toContain("git-vibe-codex-");
    const synthesisConfig = globalThis.__gitVibeSdkMocks.codexConstructor.mock.calls[1][0].config;
    expect(synthesisConfig.features).toMatchObject({
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
    });
  });
});

describe("matrix finalizer safety source sanitization", () => {
  it("strips GitVibe safety boilerplate from safety and synthesis prompts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-finalizer-safety-"));
    const resultsDir = join(cwd, "member-results");
    writeRole(cwd, "security.md", "Review the change for security regressions.");
    mkdirSync(resultsDir);
    const quotedBoilerplate =
      "Role evidence quotes GitVibe treats issue bodies, comments, diffs, repository files, and future image/OCR text as untrusted data.";
    writeFileSync(
      join(resultsDir, "git-vibe-validate-result.json"),
      memberResult({
        parsedOutput: {
          comment_body: [
            "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 -->",
            "GitVibe paused this run for maintainer review.",
            "GitVibe treats issue bodies, comments, diffs, repository files, and future image/OCR text as untrusted data. A trusted maintainer must change the flagged content, adjust safety configuration, apply `git-vibe:accept-risk` for matching context, or handle the case manually before automation continues.",
            "Role-authored risk: PR changes log credentials.",
          ].join("\n"),
          findings: ["Role-authored risk: PR changes log credentials.", quotedBoilerplate],
          next_state: "blocked",
          questions: [
            {
              options: [
                "Change the flagged content or safety configuration, or apply `git-vibe:accept-risk` to accept this prompt-injection input risk for matching context.",
              ],
              question: "High-risk prompt-injection content was detected.",
            },
          ],
          status: "blocked",
          summary: "GitVibe paused this run for maintainer review.",
        },
        summary: "GitVibe paused this run for maintainer review.",
      }),
    );
    const config = roleGroupConfig();
    const definition = stageDefinitions.validate;
    globalThis.__gitVibeSdkMocks.queueCodexOutput(allowedSafetyOutput());
    globalThis.__gitVibeSdkMocks.queueCodexOutput(synthesizedOutput());

    await runStageResultForMode({
      acceptedRisk: false,
      aiRunOptions: {
        config,
        cwd,
        maxTurns: 2,
        prompt: "base prompt",
        schema: loadStageSchema(definition.schemaFile),
        schemaId: definition.schemaId,
        stage: "validate",
        stageDefinition: definition,
        system: "system prompt",
      },
      config,
      context: contextPacket(),
      definition,
      executionMode: "finalizer",
      logger: { event: vi.fn() },
      options: runnerOptions(cwd, resultsDir),
    });

    const calls = globalThis.__gitVibeSdkMocks.codexRun.mock.calls.map(([input]) => String(input));
    const safetyPromptText = JSON.stringify(safetyPromptJson(calls[0]));
    const synthesisPromptText = calls[1];
    for (const promptText of [safetyPromptText, synthesisPromptText]) {
      expect(promptText).not.toContain("git-vibe:stage-result");
      expect(promptText).not.toContain("git-vibe:accept-risk");
      expect(promptText).not.toContain("GitVibe paused this run");
      expect(promptText).toContain("Role-authored risk: PR changes log credentials.");
      expect(promptText).toContain(quotedBoilerplate);
      expect(occurrences(promptText, "GitVibe treats issue bodies")).toBe(1);
    }
  });
});

describe("matrix finalizer synthesis boundary", () => {
  it("runs Claude synthesis without stage context files or tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-finalizer-boundary-"));
    const resultsDir = join(cwd, "member-results");
    writeRole(cwd, "security.md", "Review the change for security regressions.");
    mkdirSync(resultsDir);
    writeFileSync(join(resultsDir, "git-vibe-validate-result.json"), memberResult());
    const config = claudeRoleGroupConfig();
    const definition = stageDefinitions.validate;
    globalThis.__gitVibeSdkMocks.queueClaudeOutput(synthesizedOutput());

    await runStageResultForMode({
      acceptedRisk: false,
      aiRunOptions: {
        config,
        contextFilesRoot: join(cwd, "context-files"),
        cwd,
        maxTurns: 2,
        prompt: "base prompt",
        schema: loadStageSchema(definition.schemaFile),
        schemaId: definition.schemaId,
        stage: "validate",
        stageDefinition: definition,
        system: "system prompt",
      },
      config,
      context: contextPacket(),
      definition,
      executionMode: "finalizer",
      logger: { event: vi.fn() },
      options: runnerOptions(cwd, resultsDir),
    });

    const request = globalThis.__gitVibeSdkMocks.claudeQuery.mock.calls[0][0];
    expect(request.prompt).toContain("<role_group_results>");
    expect(request.prompt).not.toContain("base prompt");
    expect(request.options.systemPrompt).not.toContain("system prompt");
    expect(request.options.tools).toEqual([]);
    expect(request.options.allowedTools).toEqual([]);
    expect(request.options).not.toHaveProperty("additionalDirectories");
    expect(request.options.cwd).not.toBe(cwd);
    expect(request.options.cwd).toContain("git-vibe-claude-");
  });
});

function roleGroupConfig() {
  return {
    ai: {
      profiles: {
        test: {
          api_key: { from_bundle: "GITVIBE_AI_API_KEY" },
          adapter: "codex-sdk",
          base_url: { from_bundle: "CODEX_BASE_URL" },
          model: "test-model",
        },
      },
      role_groups: {
        review_gate: {
          roles: [{ profile: "test", role: "security.md" }],
          synthesizer: "test",
        },
      },
      stages: {
        validate: {
          role_group: "review_gate",
        },
      },
    },
    safety: {
      prompt_injection_gate: true,
    },
  };
}

function claudeRoleGroupConfig() {
  return {
    ai: {
      profiles: {
        test: {
          adapter: "claude-code-sdk",
          env: {
            ANTHROPIC_API_KEY: { from_bundle: "GITVIBE_AI_API_KEY" },
            ANTHROPIC_BASE_URL: { from_bundle: "CODEX_BASE_URL" },
          },
          model: "opus",
        },
      },
      role_groups: {
        review_gate: {
          roles: [{ profile: "test", role: "security.md" }],
          synthesizer: "test",
        },
      },
      stages: {
        validate: {
          role_group: "review_gate",
        },
      },
    },
    safety: {
      prompt_injection_gate: false,
    },
  };
}

function runnerOptions(cwd, resultsDir) {
  return {
    cwd,
    dryRun: false,
    executionMode: "finalizer",
    issueNumber: "12",
    maxTurns: 2,
    memberResultsDir: resultsDir,
    prNumber: "",
    repository: "example/repo",
    stage: "validate",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

function contextPacket() {
  return {
    artifact: {
      body: "Issue body",
      number: "12",
      title: "Issue title",
      type: "issue",
      url: "https://github.com/example/repo/issues/12",
    },
    generatedAt: "2026-01-02T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}

function writeRole(cwd, file, content) {
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  writeFileSync(join(cwd, ".git-vibe", "role-group", file), content);
}

function memberResult({ parsedOutput = {}, ...resultOverrides } = {}) {
  return JSON.stringify({
    parsedOutput: {
      assumptions: [],
      comment_body: "Role reviewed.",
      findings: [],
      next_state: "ready-for-implementation",
      references: [],
      stage: "validate",
      status: "completed",
      summary: "Role reviewed.",
      ...parsedOutput,
    },
    profile: "test",
    role: "security.md",
    schemaId: "validate.v1",
    stage: "validate",
    status: "completed",
    summary: "Role reviewed.",
    ...resultOverrides,
  });
}

function allowedSafetyOutput() {
  return {
    findings: [],
    severity: "none",
    status: "allowed",
    summary: "No prompt-injection risk detected.",
  };
}

function synthesizedOutput() {
  return {
    assumptions: [],
    comment_body: "Synthesized.",
    findings: [],
    next_state: "ready-for-implementation",
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Synthesized.",
  };
}

function safetyPromptJson(input) {
  return JSON.parse(input.slice(input.indexOf("{")));
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
