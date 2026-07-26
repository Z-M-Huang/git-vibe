// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isDirectRun,
  main,
  readCodexSmokeConfig,
  runCodexSmokeTest,
} from "../scripts/smoke-test-codex.mjs";

describe("Codex SDK smoke test", () => {
  it("loads proxy auth from the bundle without writing Codex auth files", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      enabled: true
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
      reasoning:
        effort: xhigh
`);

    const config = readCodexSmokeConfig({
      cwd,
      env: {
        CODEX_HOME: join(cwd, "codex-home"),
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          CODEX_BASE_URL: "https://codex-proxy.example/v1",
          GITVIBE_AI_API_KEY: "test-key",
        }),
      },
    });

    expect(config).toMatchObject({
      apiKey: "test-key",
      baseUrl: "https://codex-proxy.example/v1",
      model: "gpt-5-test",
      profileName: "codex",
      reasoningEffort: "xhigh",
    });
    expect(config.env.CODEX_HOME).toBeUndefined();
    expect(config.env.GITVIBE_AI_ENV_JSON).toBeUndefined();
    expect(existsSync(join(cwd, "codex-home", "auth.json"))).toBe(false);
  });
});

describe("Codex SDK smoke execution", () => {
  it("runs through the SDK with model, effort, schema, and bypass settings", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      enabled: true
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
      reasoning:
        effort: high
`);
    let codexHome;
    const run = vi.fn(async () => ({
      finalResponse: JSON.stringify({ ok: true, source: "codex" }),
    }));
    const startThread = vi.fn(() => ({ run }));
    const Codex = vi.fn(function Codex(options) {
      codexHome = options.env.CODEX_HOME;
      expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
      return { startThread };
    });

    const report = await runCodexSmokeTest({
      cwd,
      dependencies: { Codex },
      env: {
        CODEX_HOME: join(cwd, "runner-codex-home"),
        GITVIBE_CODEX_PATH: "/runner/codex",
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          CODEX_BASE_URL: "https://codex-proxy.example/v1",
          GITVIBE_AI_API_KEY: "test-key",
        }),
      },
    });

    expect(report).toEqual({ model: "gpt-5-test", profileName: "codex" });
    expect(codexHome).toContain("git-vibe-codex-smoke-home-");
    expect(existsSync(codexHome)).toBe(false);
    expect(Codex).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseUrl: "https://codex-proxy.example/v1",
        codexPathOverride: "/runner/codex",
        config: { features: { plugins: false }, model_provider: "openai" },
      }),
    );
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        model: "gpt-5-test",
        modelReasoningEffort: "high",
        sandboxMode: "danger-full-access",
        workingDirectory: cwd,
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.any(String), {
      outputSchema: expect.objectContaining({ required: ["ok", "source"] }),
    });
  });
});

describe("Codex SDK smoke profile selection", () => {
  it("selects requested profiles, maps literal env, and accepts fenced JSON responses", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    disabled:
      enabled: false
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: disabled
    alternate:
      enabled: true
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      env:
        EXTRA_LITERAL: literal
        CODEX_HOME: /tmp/profile-codex-home
      model: gpt-5-alt
`);
    const Codex = codexDependency('```json\n{"ok": true, "source": "codex"}\n```');

    const report = await runCodexSmokeTest({
      cwd,
      dependencies: { Codex },
      env: {
        CODEX_HOME: join(cwd, "installed-codex-home"),
        GITVIBE_AI_SMOKE_CODEX_PROFILE: "alternate",
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          CODEX_BASE_URL: "https://codex-proxy.example/v1",
          GITVIBE_AI_API_KEY: "test-key",
        }),
        PATH: "/usr/bin",
      },
    });

    expect(report).toEqual({ model: "gpt-5-alt", profileName: "alternate" });
    expect(Codex).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        baseUrl: "https://codex-proxy.example/v1",
        env: expect.objectContaining({
          EXTRA_LITERAL: "literal",
          PATH: "/usr/bin",
        }),
      }),
    );
    expect(Codex.mock.calls[0][0].env.CODEX_HOME).not.toBe(join(cwd, "installed-codex-home"));
  });
});

describe("Codex SDK smoke response parsing", () => {
  it("extracts embedded JSON responses and omits non-string child env values", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      enabled: true
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`);
    const Codex = vi.fn(function Codex(options) {
      expect(options.env.PATH).toBe("/usr/bin");
      expect(options.env.NUMERIC_VALUE).toBeUndefined();
      return {
        startThread: vi.fn(() => ({
          run: vi.fn(async () => ({
            finalResponse: 'Result: {"ok": true, "source": "codex"}.',
          })),
        })),
      };
    });

    const report = await runCodexSmokeTest({
      cwd,
      dependencies: { Codex },
      env: {
        GITVIBE_AI_ENV_JSON: JSON.stringify({
          CODEX_BASE_URL: "https://codex-proxy.example/v1",
          GITVIBE_AI_API_KEY: "test-key",
        }),
        HOME: "",
        NUMERIC_VALUE: 123,
        PATH: "/usr/bin",
      },
    });

    expect(report).toEqual({ model: "gpt-5-test", profileName: "codex" });
  });
});

describe("Codex SDK smoke main", () => {
  it("returns zero from main on successful smoke runs", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`);
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({
        cwd,
        dependencies: { Codex: codexDependency('{"ok": true, "source": "codex"}') },
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "https://codex-proxy.example/v1",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
        logger,
      }),
    ).resolves.toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      "[git-vibe] codex-sdk smoke passed with profile=codex model=gpt-5-test",
    );
  });
});

describe("Codex SDK smoke failure handling", () => {
  it("returns nonzero from main on config errors", async () => {
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({ cwd: mkdtempSync(join(tmpdir(), "git-vibe-codex-smoke-")), logger }),
    ).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(".github/git-vibe.yml is required"),
    );
  });

  it("returns nonzero from main on non-error SDK failures", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`);
    const logger = { error: vi.fn(), log: vi.fn() };

    await expect(
      main({
        cwd,
        dependencies: {
          Codex: vi.fn(function Codex() {
            throw "sdk failed";
          }),
        },
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "https://codex-proxy.example/v1",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
        logger,
      }),
    ).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith("[git-vibe] sdk failed");
  });
});

describe("Codex SDK smoke config failures", () => {
  it("rejects invalid config, bundle, env, and reasoning shapes", () => {
    expect(() => readCodexSmokeConfig({ cwd: writeConfig("[]"), env: {} })).toThrow(
      ".github/git-vibe.yml must contain a YAML object.",
    );
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig("ai:\n  profiles: []\n"),
        env: {},
      }),
    ).toThrow("ai.profiles must be an object.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    other:
      adapter: claude-code-sdk
      model: opus
`),
        env: {},
      }),
    ).toThrow("does not define an enabled codex-sdk profile");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      enabled: false
      adapter: codex-sdk
      model: gpt-5-test
`),
        env: { GITVIBE_AI_SMOKE_CODEX_PROFILE: "codex" },
      }),
    ).toThrow("AI profile codex must be an enabled codex-sdk profile.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex: []
`),
        env: {},
      }),
    ).toThrow("does not define an enabled codex-sdk profile");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
`),
        env: {},
      }),
    ).toThrow("AI profile codex model must be configured.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      model: gpt-5-test
      reasoning:
        effort: max
`),
        env: {},
      }),
    ).toThrow("reasoning.effort is not supported by codex-sdk: max");
  });
});

describe("Codex SDK smoke validation order", () => {
  it("validates reasoning before allocating smoke Codex state", () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
      reasoning:
        effort: max
`);
    const before = codexSmokeTempDirNames();

    expect(() =>
      readCodexSmokeConfig({
        cwd,
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "https://codex-proxy.example/v1",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow("reasoning.effort is not supported by codex-sdk: max");
    expect(codexSmokeTempDirNames()).toEqual(before);
  });
});

describe("Codex SDK smoke env failures", () => {
  it("rejects invalid AI env bundle shapes", () => {
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`),
        env: { GITVIBE_AI_ENV_JSON: "[]" },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON must be a JSON object.");
  });
});

describe("Codex SDK smoke profile env failures", () => {
  it("rejects invalid profile env mappings", () => {
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      env:
        "": value
      model: gpt-5-test
`),
        env: {},
      }),
    ).toThrow("env keys must be non-empty strings");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      env:
        CODEX_API_KEY:
          from_bundle: ""
      model: gpt-5-test
`),
        env: {},
      }),
    ).toThrow("ai.profiles.codex.env.CODEX_API_KEY.from_bundle must be a non-empty string.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      env:
        CODEX_API_KEY:
          from_bundle: MISSING
      model: gpt-5-test
`),
        env: { GITVIBE_AI_ENV_JSON: "{}" },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.MISSING is required");
  });
});

describe("Codex SDK smoke proxy env failures", () => {
  it("rejects invalid proxy bundle values", () => {
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`),
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: 12,
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.CODEX_BASE_URL must be a string.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`),
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "   ",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow("ai.profiles.codex.base_url.from_bundle resolved to an empty value.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`),
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "ftp://codex-proxy.example",
            GITVIBE_AI_API_KEY: "test-key",
          }),
        },
      }),
    ).toThrow("ai.profiles.codex.base_url.from_bundle must resolve to an absolute HTTP(S) URL.");
    expect(() =>
      readCodexSmokeConfig({
        cwd: writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`),
        env: {
          GITVIBE_AI_ENV_JSON: JSON.stringify({
            CODEX_BASE_URL: "https://codex-proxy.example/v1",
          }),
        },
      }),
    ).toThrow("GITVIBE_AI_ENV_JSON.GITVIBE_AI_API_KEY is required");
  });
});

describe("Codex SDK smoke response failures", () => {
  it("rejects unexpected or non-JSON SDK responses with redaction", async () => {
    const cwd = writeConfig(`
ai:
  profiles:
    codex:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5-test
`);
    const env = {
      GITVIBE_AI_ENV_JSON: JSON.stringify({
        CODEX_BASE_URL: "https://codex-proxy.example/v1",
        GITVIBE_AI_API_KEY: "secret-codex",
      }),
    };

    await expect(
      runCodexSmokeTest({
        cwd,
        dependencies: { Codex: codexDependency('{"ok": false, "source": "secret-codex"}') },
        env,
      }),
    ).rejects.toThrow('unexpected Codex SDK smoke response: {"ok":false,"source":"***"}');

    await expect(
      runCodexSmokeTest({
        cwd,
        dependencies: { Codex: codexDependency("secret-codex without json") },
        env,
      }),
    ).rejects.toThrow("Codex SDK result did not contain JSON: *** without json");
  });

  it("detects direct script execution", () => {
    expect(isDirectRun("file:///tmp/smoke-test-codex.mjs", "/tmp/smoke-test-codex.mjs")).toBe(true);
    expect(isDirectRun("file:///tmp/other.mjs", "/tmp/smoke-test-codex.mjs")).toBe(false);
    expect(isDirectRun("file:///tmp/smoke-test-codex.mjs", undefined)).toBe(false);
  });
});

function writeConfig(content) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-smoke-"));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "git-vibe.yml"), content);
  return cwd;
}

function codexDependency(finalResponse) {
  return vi.fn(function Codex() {
    return {
      startThread: vi.fn(() => ({
        run: vi.fn(async () => ({ finalResponse })),
      })),
    };
  });
}

function codexSmokeTempDirNames() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("git-vibe-codex-smoke-"))
    .sort();
}
