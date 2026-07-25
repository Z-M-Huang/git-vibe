// @ts-nocheck
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectRun, planStage } from "../src/runner/actions/plan-stage.ts";
import {
  loadMatrixStageResults,
  matrixMemberRowForStage,
  matrixResultMetadata,
  profileNamesForConfiguredStage,
  readRoleDefinition,
  singleProfileNamesForStage,
  stageFinalizerAdapter,
  stageExecutionPlan,
  stageSafetyAdapter,
  stageWorkflowAdapters,
  stageWorkflowIndexes,
  stageWorkflowLabels,
  stageWorkflowMatrix,
  synthesisPromptAddition,
  synthesizerSystemPrompt,
} from "../src/runner/role-groups.ts";

describe("role group stage planning", () => {
  it("plans role/profile matrix rows with a synthesizer profile", () => {
    const cwd = roleWorkspace({ "security.md": "Check token boundaries." });
    const plan = stageExecutionPlan(roleGroupConfig(), "review-matrix", cwd);

    expect(plan).toMatchObject({
      maxParallel: 2,
      mode: "role-group",
      roleGroup: "review_gate",
      synthesizerProfile: "synth",
    });
    expect(plan.matrix.include).toEqual([
      {
        artifact: "git-vibe-review-matrix-member-0",
        index: 0,
        model: "gpt-test",
        profile: "reviewer",
        role: "security.md",
      },
    ]);
    expect(stageWorkflowMatrix(plan)).toEqual({
      include: [{ artifact: "git-vibe-review-matrix-member-0", index: 0 }],
    });
    expect(stageWorkflowIndexes(plan)).toEqual([0]);
    expect(stageWorkflowLabels(plan)).toEqual({
      0: "security - reviewer",
    });
    expect(stageWorkflowAdapters(roleGroupConfig(), plan)).toEqual({
      0: "claude-code-sdk",
    });
    expect(stageFinalizerAdapter(roleGroupConfig(), plan)).toBe("codex-sdk");
    expect(stageSafetyAdapter(roleGroupConfig(), plan)).toBe("codex-sdk");
    expect(
      stageSafetyAdapter({ ...roleGroupConfig(), safety: { prompt_injection_gate: false } }, plan),
    ).toBe("");
    expect(matrixMemberRowForStage(roleGroupConfig(), "review-matrix", cwd, 0)).toMatchObject({
      model: "gpt-test",
      profile: "reviewer",
      role: "security.md",
    });
    expect(() => matrixMemberRowForStage(roleGroupConfig(), "review-matrix", cwd, 1)).toThrow(
      "GITVIBE_MEMBER_INDEX 1 is not configured for review-matrix.",
    );
    expect(() => matrixMemberRowForStage(roleGroupConfig(), "review-matrix", cwd, -1)).toThrow(
      "GITVIBE_MEMBER_INDEX must be a non-negative integer.",
    );

    cleanupWorkspace(cwd);
  });

  it("rejects removed profiles routing and write-stage role groups", () => {
    const config = roleGroupConfig();
    expect(() =>
      stageExecutionPlan({ ai: { stages: { validate: { profiles: ["reviewer"] } } } }, "validate"),
    ).toThrow("ai.stages.validate.profiles is no longer supported");
    expect(() =>
      stageExecutionPlan(
        {
          ai: {
            profiles: { fallback: {}, primary: {} },
            stages: { validate: { fallback_profile: "fallback", profile: "primary" } },
          },
        },
        "validate",
      ),
    ).toThrow("ai.stages.validate.fallback_profile is no longer supported");
    expect(() =>
      stageExecutionPlan(
        { ...config, ai: { ...config.ai, stages: { materialize: { role_group: "review_gate" } } } },
        "materialize",
      ),
    ).toThrow("ai.stages.materialize.role_group is only supported for read-only stages");
  });
});

describe("role group workflow labels", () => {
  it("labels workflow members from roles and profiles", () => {
    const cwd = roleWorkspace({
      "correctness.md": "Review correctness.",
      "maintainability.md": "Review maintainability.",
      "security.md": "Review security.",
    });
    const plan = stageExecutionPlan(
      {
        ai: {
          profiles: {
            secondary_profile: {},
            provider_no_model: { provider: {} },
            provider_profile: { provider: { model: "provider-model" } },
            synth: {},
          },
          role_groups: {
            review_gate: {
              roles: [
                { profile: "provider_profile", role: "security.md" },
                { profile: "secondary_profile", role: "maintainability.md" },
                { profile: "provider_no_model", role: "correctness.md" },
              ],
              synthesizer: "synth",
            },
          },
          stages: { validate: { role_group: "review_gate" } },
        },
      },
      "validate",
      cwd,
    );

    expect(stageWorkflowLabels(plan)).toEqual({
      0: "security - provider_profile",
      1: "maintainability - secondary_profile",
      2: "correctness - provider_no_model",
    });

    cleanupWorkspace(cwd);
  });
});

describe("profile stage planning", () => {
  it("plans profile stages and exposes configured profile names", () => {
    const config = {
      ai: {
        profiles: { primary: {}, synth: {} },
        stages: {
          validate: { profile: "primary" },
        },
      },
    };

    expect(stageExecutionPlan(config, "validate")).toMatchObject({
      matrix: { include: [{ profile: "primary", role: "" }] },
      mode: "profile",
    });
    expect(profileNamesForConfiguredStage(config, "validate")).toEqual(["primary"]);
    expect(singleProfileNamesForStage(config, "validate")).toEqual(["primary"]);
    expect(
      singleProfileNamesForStage(
        { ai: { profiles: { primary: {} }, stages: { validate: { profile: "primary" } } } },
        "validate",
      ),
    ).toEqual(["primary"]);
  });
});

describe("role group config validation", () => {
  it("reports malformed role group config with specific paths", () => {
    expect(() =>
      stageExecutionPlan({ ai: { profiles: {}, stages: { validate: {} } } }, "validate"),
    ).toThrow("ai.stages.validate must define profile or role_group");
    expect(() =>
      singleProfileNamesForStage(
        { ai: { profiles: {}, stages: { validate: { role_group: "review_gate" } } } },
        "validate",
      ),
    ).toThrow("ai.stages.validate.role_group requires matrix workflow execution");
    expect(() =>
      stageExecutionPlan(
        {
          ai: {
            profiles: { reviewer: {} },
            stages: { validate: { profile: "reviewer", role_group: "review_gate" } },
          },
        },
        "validate",
      ),
    ).toThrow("cannot define both profile and role_group");
    expect(() =>
      stageExecutionPlan(
        { ai: { profiles: { reviewer: {} }, stages: { validate: { role_group: "missing" } } } },
        "validate",
      ),
    ).toThrow("ai.role_groups must be an object");
    expect(() =>
      stageExecutionPlan(
        {
          ai: {
            profiles: { reviewer: {} },
            role_groups: { review_gate: [] },
            stages: { validate: { role_group: "review_gate" } },
          },
        },
        "validate",
      ),
    ).toThrow("ai.role_groups.review_gate must be an object");
  });

  it("reports malformed role group fields", () => {
    expectRoleGroupError({ roles: [] }, "synthesizer must be configured");
    expectRoleGroupError({ roles: [], synthesizer: "missing" }, "ai.profiles.missing");
    expectRoleGroupError({ roles: [], synthesizer: "synth" }, "roles must be a non-empty array");
    expectRoleGroupError(
      { roles: ["security.md"], synthesizer: "synth" },
      "roles[0] must be an object",
    );
    expectRoleGroupError(
      { roles: [{ role: "security.md" }], synthesizer: "synth" },
      "roles[0] must define role and profile",
    );
    expectRoleGroupError(
      { parallel: 0, roles: [{ profile: "reviewer", role: "security.md" }], synthesizer: "synth" },
      "parallel must be a positive integer",
    );
    expectRoleGroupError(
      {
        roles: Array.from({ length: 257 }, () => ({ profile: "reviewer", role: "security.md" })),
        synthesizer: "synth",
      },
      "roles cannot exceed 256 entries",
    );
  });
});

describe("role group files and results", () => {
  it("rejects unsafe role filenames and symlinked role files", () => {
    const cwd = roleWorkspace({});
    expect(() =>
      stageExecutionPlan(roleGroupConfig("../security.md"), "review-matrix", cwd),
    ).toThrow("role must be a markdown filename");

    const outside = mkdtempSync(join(tmpdir(), "git-vibe-role-outside-"));
    writeFileSync(join(outside, "security.md"), "external role");
    symlinkSync(join(outside, "security.md"), join(cwd, ".git-vibe", "role-group", "security.md"));

    try {
      expect(() => readRoleDefinition(cwd, "security.md")).toThrow(
        "Role definition must be a regular file",
      );
    } finally {
      cleanupWorkspace(cwd);
      cleanupWorkspace(outside);
    }
  });

  it("rejects empty and non-regular role files", () => {
    const cwd = roleWorkspace({ "empty.md": " \n" });
    mkdirSync(join(cwd, ".git-vibe", "role-group", "directory.md"));

    try {
      expect(() => readRoleDefinition(cwd, "empty.md")).toThrow("must not be empty");
      expect(() => readRoleDefinition(cwd, "directory.md")).toThrow("must be a regular file");
      expect(() => readRoleDefinition(cwd, "not-markdown.txt")).toThrow(
        "must be a markdown filename",
      );
    } finally {
      cleanupWorkspace(cwd);
    }
  });
});

describe("role group result loading", () => {
  it("loads matrix stage results defensively", () => {
    const cwd = roleWorkspace({});
    const nested = join(cwd, "nested");
    const nestedDefaults = join(cwd, "nested-defaults");
    mkdirSync(nested);
    mkdirSync(nestedDefaults);
    writeFileSync(join(cwd, "git-vibe-review-matrix-result.json"), memberResult({ profile: "" }));
    writeFileSync(join(nested, "git-vibe-review-matrix-result.json"), memberResult({ role: "" }));
    writeFileSync(
      join(nestedDefaults, "git-vibe-review-matrix-result.json"),
      JSON.stringify({ parsedOutput: {}, stage: "review-matrix" }),
    );
    writeFileSync(join(cwd, "git-vibe-validate-result.json"), memberResult({ stage: "validate" }));
    writeFileSync(join(cwd, "git-vibe-bad-result.json"), "{not json");

    expect(loadMatrixStageResults(undefined, "review-matrix")).toEqual([]);
    expect(loadMatrixStageResults(join(cwd, "missing"), "review-matrix")).toEqual([]);
    const results = loadMatrixStageResults(cwd, "review-matrix");
    expect(results).toHaveLength(3);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: "",
          role: "security.md",
          schemaId: "review-matrix.v1",
          status: "completed",
        }),
        expect.objectContaining({ profile: "reviewer", role: "" }),
        expect.objectContaining({
          schemaId: "review-matrix.v1",
          status: "completed",
          summary: "review-matrix completed.",
        }),
      ]),
    );
    expect(
      matrixResultMetadata({
        result: { schemaId: "review-matrix.v1", status: "completed", summary: "Done." },
      }),
    ).toMatchObject({ profile: "", role: "" });
    const synthesizerSystem = synthesizerSystemPrompt("review-matrix");
    expect(synthesizerSystem).toContain("<role_group_synthesizer>");
    expect(synthesizerSystem).toContain("Build every output field from the member results.");
    expect(synthesizerSystem).toContain("Preserve every distinct member finding.");
    expect(synthesizerSystem).toContain(
      "Merge findings only when they describe the same underlying issue",
    );
    expect(synthesizerSystem).not.toContain("Inspect the repository");
    expect(synthesizerSystem).not.toContain("add your own findings");
    expect(synthesizerSystem).not.toContain("Discard false positives");
    expect(synthesizerSystem).toContain(
      "Every inline_comments finding_id must be unique in the final output.",
    );
    expect(synthesizerSystemPrompt("validate")).not.toContain("inline_comments finding_id");

    cleanupWorkspace(cwd);
  });

  it("renders deterministic synthesizer input", () => {
    const prompt = synthesisPromptAddition({
      expected: 2,
      failed: 1,
      members: [
        {
          artifact: "git-vibe-review-matrix-member-0",
          index: 0,
          profile: "reviewer",
          role: "security.md",
        },
      ],
      results: [
        {
          parsedOutput: { findings: ["src/app.ts:1 bug"], stage: "review-matrix" },
          profile: "reviewer",
          role: "security.md",
          schemaId: "review-matrix.v1",
          stage: "review-matrix",
          status: "completed",
          summary: "Security reviewed.",
        },
      ],
      roleGroup: "review_gate",
      stage: "review-matrix",
    });

    expect(prompt).toContain("<role_group_results>");
    expect(prompt).toContain('"successful_results": 1');
    expect(prompt).toContain('"failed_results": 1');
    expect(prompt).toContain('"configured_members"');
    expect(prompt).not.toContain("role_definition");
    expect(prompt).toContain("security.md");
  });
});

describe("plan-stage action", () => {
  it("writes matrix outputs from repository config", () => {
    const cwd = roleWorkspace({ "security.md": "Check token boundaries." });
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      [
        "ai:",
        "  profiles:",
        "    reviewer:",
        "      adapter: claude-code-sdk",
        "      model: gpt-test",
        "    synth:",
        "      adapter: codex-sdk",
        "      model: gpt-synth",
        "  role_groups:",
        "    review_gate:",
        "      synthesizer: synth",
        "      roles:",
        "        - role: security.md",
        "          profile: reviewer",
        "  stages:",
        "    review-matrix:",
        "      role_group: review_gate",
      ].join("\n"),
    );
    const output = join(cwd, "outputs");
    const code = planStage({
      argv: ["review-matrix"],
      env: { GITHUB_OUTPUT: output, GITHUB_WORKSPACE: cwd },
      log: () => undefined,
    });

    expect(code).toBe(0);
    const outputContent = readFileSync(output, "utf8");
    const matrixOutput =
      'matrix<<GITVIBE_OUTPUT\n{"include":[{"artifact":"git-vibe-review-matrix-member-0","index":0}]}';
    expect(outputContent).toContain("mode<<GITVIBE_OUTPUT\nrole-group");
    expect(outputContent).toContain("git-vibe-review-matrix-member-0");
    expect(outputContent).toContain("indexes<<GITVIBE_OUTPUT\n[0]");
    expect(outputContent).toContain('labels<<GITVIBE_OUTPUT\n{"0":"security - reviewer"}');
    expect(outputContent).toContain('adapters<<GITVIBE_OUTPUT\n{"0":"claude-code-sdk"}');
    expect(outputContent).toContain("finalizer-adapter<<GITVIBE_OUTPUT\ncodex-sdk");
    expect(outputContent).toContain("safety-adapter<<GITVIBE_OUTPUT\ncodex-sdk");
    expect(readFileSync("plan-stage/action.yml", "utf8")).toContain(
      "value: ${{ steps.plan.outputs.indexes }}",
    );
    expect(readFileSync("plan-stage/action.yml", "utf8")).toContain(
      "value: ${{ steps.plan.outputs.labels }}",
    );
    expect(readFileSync("plan-stage/action.yml", "utf8")).toContain(
      "value: ${{ steps.plan.outputs.adapters }}",
    );
    expect(readFileSync("plan-stage/action.yml", "utf8")).toContain(
      "value: ${{ steps.plan.outputs.finalizer-adapter }}",
    );
    expect(readFileSync("plan-stage/action.yml", "utf8")).toContain(
      "value: ${{ steps.plan.outputs.safety-adapter }}",
    );
    expect(outputContent).toContain(matrixOutput);
    expect(matrixOutput).not.toContain("security.md");
    expect(matrixOutput).not.toContain("reviewer");

    cleanupWorkspace(cwd);
  });

  it("reports planning errors and handles missing output paths", () => {
    const errors = [];
    expect(
      planStage({
        argv: ["missing"],
        env: {},
        error: (message) => errors.push(message),
        log: () => undefined,
      }),
    ).toBe(1);
    expect(errors[0]).toContain("Unknown GitVibe action stage");
    expect(planStage({ argv: ["validate"], env: {}, log: () => undefined })).toBe(0);
    expect(isDirectRun("", "/tmp/plan-stage.ts")).toBe(true);
    expect(isDirectRun("", "/tmp/other.ts")).toBe(false);
    expect(isDirectRun(pathToFileURL("/tmp/plan-stage.js").href, "/tmp/plan-stage.js")).toBe(true);
    expect(isDirectRun(pathToFileURL("/tmp/plan-stage.js").href, "/tmp/other.js")).toBe(false);
  });
});

function roleGroupConfig(role = "security.md") {
  return {
    ai: {
      profiles: {
        reviewer: { adapter: "claude-code-sdk", model: "gpt-test" },
        synth: { adapter: "codex-sdk", model: "gpt-synth" },
      },
      role_groups: {
        review_gate: {
          parallel: 2,
          roles: [{ profile: "reviewer", role }],
          synthesizer: "synth",
        },
      },
      stages: {
        "review-matrix": {
          role_group: "review_gate",
        },
      },
    },
  };
}

function expectRoleGroupError(group, message) {
  const cwd = roleWorkspace({ "security.md": "Review security." });
  try {
    expect(() =>
      stageExecutionPlan(
        {
          ai: {
            profiles: { reviewer: {}, synth: {} },
            role_groups: { review_gate: group },
            stages: { "review-matrix": { role_group: "review_gate" } },
          },
        },
        "review-matrix",
        cwd,
      ),
    ).toThrow(message);
  } finally {
    cleanupWorkspace(cwd);
  }
}

function memberResult(overrides = {}) {
  const stage = overrides.stage || "review-matrix";
  return JSON.stringify({
    parsedOutput: {
      assumptions: [],
      comment_body: "Role reviewed.",
      findings: [],
      next_state: stage === "validate" ? "ready-for-implementation" : "review-passed",
      references: [],
      stage,
      status: "completed",
      summary: "Role reviewed.",
    },
    profile: "reviewer",
    role: "security.md",
    schemaId: `${stage}.v1`,
    stage,
    status: "completed",
    summary: "Role reviewed.",
    ...overrides,
  });
}

function roleWorkspace(files) {
  const cwd = mkdtempSync(join(tmpdir(), "git-vibe-role-group-"));
  mkdirSync(join(cwd, ".git-vibe", "role-group"), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(cwd, ".git-vibe", "role-group", file), content);
  }
  return cwd;
}

function cleanupWorkspace(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}
