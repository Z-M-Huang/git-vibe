import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { workflowBudgetInputsFor } from "../src/shared/budgets.ts";

/**
 * @typedef {{ default?: unknown, required?: boolean, type?: string }} WorkflowInput
 * @typedef {{ concurrency?: { group?: string, ["cancel-in-progress"]?: boolean }, env?: Record<string, string>, inputs?: Record<string, WorkflowInput>, jobs?: Record<string, WorkflowJob>, name?: string, on?: { pull_request_target?: { branches?: string[], types?: string[] }, push?: { paths?: string[] }, workflow_call?: { inputs?: Record<string, WorkflowInput>, secrets?: Record<string, { required?: boolean }> }, workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } }, outputs?: Record<string, { description?: string, value?: string }>, permissions?: Record<string, string>, ["run-name"]?: string }} Workflow
 * @typedef {{ env?: Record<string, string>, environment?: unknown, if?: string, name?: string, needs?: string | string[], outputs?: Record<string, string>, permissions?: Record<string, string>, secrets?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: string | number, uses?: string, with?: Record<string, unknown> }} WorkflowJob
 * @typedef {{ env?: Record<string, string>, id?: string, if?: string, name?: string, run?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ env: Record<string, string>, name?: string, uses?: string, with?: Record<string, unknown> }} SimulatedStep
 * @typedef {{ inputs?: Record<string, WorkflowInput>, runs?: { steps?: WorkflowStep[] } }} ActionDefinition
 */

const aiEnv = {
  GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
};
const mcpEnv = {
  GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
};
const legacyAiEnvNames = [
  "GITVIBE_AI_API_KEY",
  "GITVIBE_AI_BASE_URL",
  "CODEX_AUTH_JSON",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

const reusableWorkflows = [
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/review.yml",
  ".github/workflows/validate.yml",
];

const consumerWorkflows = [
  "examples/consumer/.github/workflows/investigate.yml",
  "examples/consumer/.github/workflows/materialize.yml",
  "examples/consumer/.github/workflows/review.yml",
  "examples/consumer/.github/workflows/validate.yml",
];

const consumerWorkflowBudgetConfig = {
  ai: {
    budgets: Object.fromEntries(
      "default_max_turns default_timeout_minutes review_timeout_minutes"
        .split(" ")
        .map((key) => [key, 1]),
    ),
  },
};

const actionFiles = [
  "investigate/action.yml",
  "mark-blocked/action.yml",
  "materialize/action.yml",
  "plan-stage/action.yml",
  "review-matrix/action.yml",
  "security-review/action.yml",
  "validate/action.yml",
];
const sdkStageActionFiles = [
  "investigate/action.yml",
  "materialize/action.yml",
  "review-matrix/action.yml",
  "validate/action.yml",
];

const workflowRunNameSpecs = [
  { file: ".github/workflows/release.yml", stage: "release" },
  { file: ".github/workflows/validate.yml", stage: "validate", multiArtifact: true },
  { file: ".github/workflows/materialize.yml", stage: "materialize", artifact: "Discussion" },
  { file: ".github/workflows/investigate.yml", stage: "investigate", artifact: "Issue" },
  { file: ".github/workflows/review.yml", stage: "review", artifact: "PR" },
  {
    file: ".github/workflows/automatic-pr-review.yml",
    stage: "automatic-pr-review",
    artifact: "PR",
  },
  {
    file: "examples/consumer/.github/workflows/validate.yml",
    stage: "validate",
    multiArtifact: true,
  },
  {
    file: "examples/consumer/.github/workflows/materialize.yml",
    stage: "materialize",
    artifact: "Discussion",
  },
  {
    file: "examples/consumer/.github/workflows/investigate.yml",
    stage: "investigate",
    artifact: "Issue",
  },
  { file: "examples/consumer/.github/workflows/review.yml", stage: "review", artifact: "PR" },
];

const workflowStaticNames = {
  ".github/workflows/release.yml": "GitVibe release",
  ".github/workflows/validate.yml": "GitVibe validate",
  ".github/workflows/materialize.yml": "GitVibe materialize",
  ".github/workflows/investigate.yml": "GitVibe investigate",
  ".github/workflows/review.yml": "GitVibe review",
  ".github/workflows/automatic-pr-review.yml": "GitVibe automatic PR review",
  "examples/consumer/.github/workflows/validate.yml": "GitVibe validate",
  "examples/consumer/.github/workflows/materialize.yml": "GitVibe materialize",
  "examples/consumer/.github/workflows/investigate.yml": "GitVibe investigate",
  "examples/consumer/.github/workflows/review.yml": "GitVibe review",
};

describe("GitVibe workflow run names", () => {
  it("defines run-name in all workflows with [git-vibe] prefix and stage identifier", () => {
    for (const spec of workflowRunNameSpecs) {
      const workflow = readWorkflow(spec.file);
      const runName = workflow["run-name"];
      expect(runName, `${spec.file} should define run-name`).toBeDefined();
      expect(runName, `${spec.file} run-name should contain [git-vibe]`).toContain("[git-vibe]");
      expect(runName, `${spec.file} run-name should contain stage [${spec.stage}]`).toContain(
        `[${spec.stage}]`,
      );
      if (spec.artifact) {
        expect(runName, `${spec.file} run-name should reference ${spec.artifact}`).toContain(
          spec.artifact,
        );
      }
      if (spec.multiArtifact) {
        expect(runName, `${spec.file} run-name should handle multiple artifact types`).toContain(
          "inputs.discussion-number",
        );
        expect(runName, `${spec.file} run-name should handle multiple artifact types`).toContain(
          "inputs.issue-number",
        );
      }
    }
  });

  it("preserves static name field in all workflows", () => {
    for (const [file, expectedName] of Object.entries(workflowStaticNames)) {
      const workflow = readWorkflow(file);
      expect(workflow.name, `${file} should preserve static name`).toBe(expectedName);
    }
  });
});

describe("GitVibe workflow wiring", () => {
  it("passes AI and MCP environment only into reusable AI action source runs", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const steps = gitVibeActionSteps(workflow, (uses) => uses.startsWith("./.git-vibe/actions/"));

      expect(
        steps.length,
        `${file} should invoke at least one checked-out GitVibe action`,
      ).toBeGreaterThan(0);
      for (const step of steps) {
        if (step.uses === "./.git-vibe/actions/plan-stage") {
          expect(step.env?.GITVIBE_AI_ENV_JSON, `${file} ${step.uses} omits AI env`).toBe("");
          expect(step.env?.GITVIBE_MCP_ENV_JSON, `${file} ${step.uses} omits MCP env`).toBe("");
          continue;
        }
        if (step.uses === "./.git-vibe/actions/mark-blocked") {
          expect(
            step.env?.GITVIBE_AI_ENV_JSON,
            `${file} ${step.uses} omits AI env`,
          ).toBeUndefined();
          expect(
            step.env?.GITVIBE_MCP_ENV_JSON,
            `${file} ${step.uses} omits MCP env`,
          ).toBeUndefined();
          continue;
        }
        if (step.uses === "./.git-vibe/actions/security-review") {
          expect(step.env, `${file} ${step.uses} receives AI and MCP env`).toMatchObject({
            ...aiEnv,
            ...mcpEnv,
          });
          continue;
        }
        expect(step.env, `${file} ${step.uses} receives AI and MCP env`).toMatchObject({
          ...aiEnv,
          ...mcpEnv,
        });
        for (const name of legacyAiEnvNames) {
          expect(step.env?.[name], `${file} ${step.uses} omits ${name}`).toBeUndefined();
        }
      }
    }
  });

  it("removes standalone adapter secret wiring from reusable workflows", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const workflowCall = workflow.on?.workflow_call;

      expect(
        workflowCall?.secrets?.CODEX_AUTH_JSON,
        `${file} omits old Codex auth`,
      ).toBeUndefined();
      expect(
        workflowCall?.secrets?.CLAUDE_CODE_OAUTH_TOKEN,
        `${file} omits old Claude auth`,
      ).toBeUndefined();
      for (const name of legacyAiEnvNames) {
        expect(workflow.env?.[name], `${file} omits ${name} at workflow scope`).toBeUndefined();
      }
      expect(
        workflow.env?.GITVIBE_AI_ENV_JSON,
        `${file} omits AI bundle at workflow scope`,
      ).toBeUndefined();
      expect(
        workflow.env?.GITVIBE_MCP_ENV_JSON,
        `${file} omits MCP bundle at workflow scope`,
      ).toBeUndefined();
    }
  });
});

describe("GitVibe workflow call wiring", () => {
  it("makes reusable workflows callable and manually dispatchable", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const workflowCall = workflow.on?.workflow_call;
      const checkoutSteps = gitVibeActionSteps(workflow, (uses) => uses === "actions/checkout@v7");
      const actionSourceSteps = checkoutSteps.filter(
        ({ name }) => name === "Checkout GitVibe action source",
      );

      expect(workflow.on?.workflow_dispatch, `${file} declares workflow_dispatch`).toBeTruthy();
      expect(workflow.on?.workflow_dispatch?.inputs?.["action-repository"]).toBeUndefined();
      expect(workflow.on?.workflow_dispatch?.inputs?.["action-ref"]).toBeUndefined();
      expect(workflow.on?.workflow_dispatch?.inputs?.["dry-run"]).toBeUndefined();
      expect(workflowCall?.inputs?.["action-repository"]).toBeUndefined();
      expect(workflowCall?.inputs?.["action-ref"]).toBeUndefined();
      expect(workflowCall?.inputs?.["dry-run"]).toBeUndefined();
      expect(workflowCall?.secrets?.GITVIBE_AI_ENV_JSON).toMatchObject({ required: true });
      expect(workflowCall?.secrets?.GITVIBE_MCP_ENV_JSON).toMatchObject({ required: false });
      expect(workflowCall?.secrets?.GITVIBE_GITHUB_TOKEN).toBeUndefined();
      expect(workflowCall?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      const oidcJobs = workflowJobsRequiringIdToken(workflow);
      expect(oidcJobs.length, `${file} has GitVibe jobs that request hosted auth`).toBeGreaterThan(
        0,
      );
      expect(workflowJobsHaveIdToken(workflow, oidcJobs), `${file} grants OIDC tokens`).toBe(true);
      expect(actionSourceSteps.length).toBeGreaterThan(0);
      for (const step of actionSourceSteps) {
        expect(step.with?.repository).toBe("${{ job.workflow_repository }}");
        expect(step.with?.ref).toBe("${{ job.workflow_sha }}");
      }
    }
  });

  it("passes AI secrets from consumer wrapper workflows", () => {
    for (const file of consumerWorkflows) {
      const workflow = readWorkflow(file);
      const jobs = Object.values(workflow.jobs || {});
      const reusableJobs = jobs.filter((job) =>
        String(job.uses || "").startsWith("markhuangai/git-vibe/.github/workflows/"),
      );

      const reusableJob = reusableJobs[0];
      expect(reusableJobs.length, `${file} should call a GitVibe reusable workflow`).toBe(1);
      expect(reusableJob?.uses, `${file} uses hosted-auth reusable workflow release`).toMatch(
        /@v4\.0\.0$/,
      );
      expect(reusableJob?.secrets).toMatchObject({
        GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
        GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
      });
      expect(reusableJob?.secrets?.GITVIBE_GITHUB_TOKEN).toBeUndefined();
      expect(reusableJob?.permissions?.["id-token"]).toBe("write");
      expect(reusableJob?.secrets?.GITVIBE_AI_API_KEY, `${file} omits old AI key`).toBeUndefined();
      expect(reusableJob?.secrets?.CODEX_AUTH_JSON, `${file} omits old Codex auth`).toBeUndefined();
      expect(reusableJob?.secrets?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(reusableJob?.with?.["action-repository"]).toBeUndefined();
      expect(reusableJob?.with?.["action-ref"]).toBeUndefined();
      expect(reusableJob?.with?.["dry-run"]).toBeUndefined();
      expect(workflow.on?.workflow_dispatch?.inputs?.["dry-run"]).toBeUndefined();
    }
  });
});

describe("GitVibe removed public inputs", () => {
  it("does not expose removed action inputs", () => {
    for (const file of actionFiles) {
      const action = readAction(file);
      const content = readFileSync(file, "utf8");
      expect(action.inputs?.["dry-run"], file).toBeUndefined();
      expect(content, file).not.toContain("GITVIBE_DRY_RUN: ${{ inputs.");
      if (!sdkStageActionFiles.includes(file)) continue;
      expect(action.inputs?.profile, file).toBeUndefined();
      expect(action.inputs?.role, file).toBeUndefined();
      expect(content, file).not.toContain("GITVIBE_PROFILE_NAME");
      expect(content, file).not.toContain("GITVIBE_ROLE_NAME");
    }
  });
});

describe("GitVibe hosted auth workflow contract", () => {
  it("does not require repository environments for hosted auth", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        expect(job.environment, `${file} ${jobName} omits environment`).toBeUndefined();
      }
    }
  });

  it("uses stable matrix member job prefixes for hosted auth authorization", () => {
    const memberJobs = [
      {
        file: ".github/workflows/investigate.yml",
        job: "investigate-members",
        prefix: "git-vibe-investigate-member-${{ matrix.index }} / ",
      },
      {
        file: ".github/workflows/review.yml",
        job: "review-matrix-members",
        prefix: "git-vibe-review-member-${{ matrix.index }} / ",
      },
      {
        file: ".github/workflows/validate.yml",
        job: "validate-members",
        prefix: "git-vibe-validate-member-${{ matrix.index }} / ",
      },
    ];

    for (const { file, job, prefix } of memberJobs) {
      const name = readWorkflow(file).jobs?.[job]?.name || "";
      expect(name, `${file} ${job}`).toContain(prefix);
      expect(name, `${file} ${job}`).toContain("${{ fromJSON(");
    }
  });
});

describe("GitVibe workflow budget wiring", () => {
  it("declares and forwards every budget input the server dispatches to consumer wrappers", () => {
    for (const file of consumerWorkflows) {
      const workflowName = file.slice(file.lastIndexOf("/") + 1);
      const workflow = readWorkflow(file);
      const budgetInputs = workflowBudgetInputsFor(consumerWorkflowBudgetConfig, workflowName);
      const reusableJob = Object.values(workflow.jobs || {}).find((job) =>
        String(job.uses || "").startsWith("markhuangai/git-vibe/.github/workflows/"),
      );

      for (const inputName of Object.keys(budgetInputs)) {
        expect(
          workflow.on?.workflow_dispatch?.inputs?.[inputName],
          `${file} declares dispatch input ${inputName}`,
        ).toMatchObject({
          required: false,
          type: "number",
        });
        expect(reusableJob?.with?.[inputName], `${file} forwards ${inputName}`).toBe(
          `\${{ fromJSON(github.event.inputs.${inputName}) }}`,
        );
      }
    }
  });
});

describe("GitVibe AI smoke workflow", () => {
  it("validates Codex and Claude Code SDK responses through SDK smoke tests", () => {
    const workflow = readWorkflow(".github/workflows/ai-smoke.yml");
    const claudeSetupNode = workflow.jobs?.["claude-code"]?.steps?.find(
      (step) => step.uses === "actions/setup-node@v6",
    );
    const codexRun = workflowStep(workflow, "codex", "Run Codex SDK smoke test")?.run || "";
    const codexPrepare = workflowStep(workflow, "codex", "Prepare Codex executable")?.run || "";
    const claudeRun =
      workflowStep(workflow, "claude-code", "Run Claude Code SDK smoke test")?.run || "";
    const claudePrepare =
      workflowStep(workflow, "claude-code", "Prepare Claude Code executable")?.run || "";
    const claudeInstall = workflow.jobs?.["claude-code"]?.steps?.some(
      (step) => step.run === "pnpm install --frozen-lockfile",
    );

    expect(claudeSetupNode).toMatchObject({
      with: { "node-version": 22, "package-manager-cache": false },
    });
    expect(claudeInstall).toBe(true);
    expect(claudePrepare).toContain("bash scripts/prepare-claude-code.sh");
    expect(codexPrepare).toContain("bash scripts/prepare-codex.sh");
    expect(codexRun).toContain("node scripts/smoke-test-codex.mjs");
    expect(codexRun).not.toContain("codex exec");
    expect(codexRun).not.toContain("codex --version");

    expect(claudeRun).toContain("node scripts/smoke-test-claude-code.mjs");
    expect(claudeRun).not.toContain("claude -p");
    expect(claudeRun).not.toContain("claude --version");
  });
});

describe("GitVibe workflow repository selection", () => {
  it("keeps repository and branch selection deterministic", () => {
    const files = [...reusableWorkflows, ...consumerWorkflows, ...actionFiles];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} should not expose a source/base branch input`).not.toContain(
        "base-branch",
      );
      expect(content, `${file} should not expose target owner/repo input`).not.toContain(
        "owner/repo",
      );
      expect(content, `${file} should not pass repository env overrides`).not.toContain(
        "GITVIBE_REPOSITORY",
      );
      expect(content, `${file} should not expose GitVibe config path overrides`).not.toContain(
        "config-path",
      );
      expect(content, `${file} should not pass GitVibe config path env`).not.toContain(
        "GITVIBE_CONFIG_PATH",
      );
    }
  });
});

describe("GitVibe Claude Code action setup", () => {
  it("documents Linux and macOS runner support without Windows runner setup", () => {
    const prepareScript = readFileSync("scripts/prepare-claude-code.sh", "utf8");
    const resolveScript = readFileSync("scripts/resolve-claude-code-path.mjs", "utf8");

    expect(prepareScript).toContain("Darwin|Linux");
    expect(prepareScript).toContain("supports Linux and macOS runners only");
    expect(resolveScript).not.toContain("win32");
    expect(resolveScript).not.toContain("claude.exe");
  });

  it("fails fast when a configured Claude Code executable path is invalid", () => {
    const result = spawnSync(process.execPath, ["scripts/resolve-claude-code-path.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITVIBE_CLAUDE_CODE_PATH: "/tmp/git-vibe-missing-claude",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GITVIBE_CLAUDE_CODE_PATH is not executable: /tmp/git-vibe-missing-claude",
    );
  });
});

describe("GitVibe Codex action setup", () => {
  it("documents Linux and macOS runner support without Windows runner setup", () => {
    const prepareScript = readFileSync("scripts/prepare-codex.sh", "utf8");
    const resolveScript = readFileSync("scripts/resolve-codex-path.mjs", "utf8");

    expect(prepareScript).toContain("Darwin|Linux");
    expect(prepareScript).toContain("supports Linux and macOS runners only");
    expect(resolveScript).not.toContain("win32");
    expect(resolveScript).not.toContain("codex.exe");
  });

  it("leaves SDK executable resolution to the selected adapter in stage actions", () => {
    for (const file of sdkStageActionFiles) {
      const content = readFileSync(file, "utf8");
      const verifyStep = content.indexOf("Verify GitVibe action runtime");
      const runEntrypoint = content.indexOf("dist/actions/run-action.js");

      expect(content, `${file} should not prepare Claude before profile selection`).not.toContain(
        "Prepare Claude Code executable",
      );
      expect(
        content,
        `${file} should not invoke Claude setup before profile selection`,
      ).not.toContain("scripts/prepare-claude-code.sh");
      expect(content, `${file} should not prepare Codex before profile selection`).not.toContain(
        "Prepare Codex executable",
      );
      expect(
        content,
        `${file} should not invoke Codex setup before profile selection`,
      ).not.toContain("scripts/prepare-codex.sh");
      expect(verifyStep, `${file} should verify before running generated entrypoint`).toBeLessThan(
        runEntrypoint,
      );
    }
  });

  it("prepares selected provider executables before reusable workflow AI execution", () => {
    const matrixSpecs = [
      [
        ".github/workflows/investigate.yml",
        "plan-investigate",
        "investigate-members",
        "investigate",
      ],
      [
        ".github/workflows/review.yml",
        "plan-review-matrix",
        "review-matrix-members",
        "review-matrix",
      ],
      [".github/workflows/validate.yml", "plan-validate", "validate-members", "validate"],
    ];

    for (const [file, planJobName, memberJobName, finalizerJobName] of matrixSpecs) {
      const workflow = readWorkflow(file);
      const planJob = workflow.jobs?.[planJobName];
      const memberJob = workflow.jobs?.[memberJobName];
      const finalizerJob = workflow.jobs?.[finalizerJobName];

      expect(planJob?.outputs, `${file} exposes member adapters`).toMatchObject({
        adapters: "${{ steps.plan.outputs.adapters }}",
        "finalizer-adapter": "${{ steps.plan.outputs.finalizer-adapter }}",
        "safety-adapter": "${{ steps.plan.outputs.safety-adapter }}",
      });
      expectProviderPrepareBeforeAction({
        action: `./.git-vibe/actions/${finalizerJobName}`,
        codexIf: `\${{ needs.${planJobName}.outputs.finalizer-adapter == 'codex-sdk' }}`,
        job: finalizerJob,
        label: `${file} ${finalizerJobName}`,
        claudeIf: `\${{ needs.${planJobName}.outputs.finalizer-adapter == 'claude-code-sdk' }}`,
      });
      expectProviderPrepareBeforeAction({
        action: `./.git-vibe/actions/${finalizerJobName}`,
        codexIf: `\${{ fromJSON(needs.${planJobName}.outputs.adapters)[format('{0}', matrix.index)] == 'codex-sdk' }}`,
        job: memberJob,
        label: `${file} ${memberJobName}`,
        claudeIf: `\${{ fromJSON(needs.${planJobName}.outputs.adapters)[format('{0}', matrix.index)] == 'claude-code-sdk' }}`,
      });
    }

    const materialize = readWorkflow(".github/workflows/materialize.yml");
    expect(materialize.jobs?.["plan-materialize"]?.outputs).toMatchObject({
      "finalizer-adapter": "${{ steps.plan.outputs.finalizer-adapter }}",
      "safety-adapter": "${{ steps.plan.outputs.safety-adapter }}",
    });
    expectProviderPrepareBeforeAction({
      action: "./.git-vibe/actions/materialize",
      codexIf: "${{ needs.plan-materialize.outputs.finalizer-adapter == 'codex-sdk' }}",
      job: materialize.jobs?.materialize,
      label: ".github/workflows/materialize.yml materialize",
      claudeIf: "${{ needs.plan-materialize.outputs.finalizer-adapter == 'claude-code-sdk' }}",
    });
  });
});

describe("GitVibe workflow numeric inputs", () => {
  it("coerces workflow-dispatch timeout inputs before assigning job timeouts", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const timeout = job["timeout-minutes"];
        if (String(job.uses || "").startsWith("./.github/workflows/")) continue;
        if (jobName.startsWith("plan-")) {
          expect(timeout).toBe(10);
          continue;
        }
        expect(timeout, `${file} ${jobName} timeout uses fromJSON`).toMatch(
          /^\$\{\{ fromJSON\(inputs\.[a-z_]+_minutes\) \}\}$/,
        );
      }
    }
  });
});

describe("GitVibe workflow write permissions", () => {
  it("grants write permissions where stage result comments are published", () => {
    expect(
      readWorkflow(".github/workflows/validate.yml").jobs?.validate?.permissions,
    ).toMatchObject({
      discussions: "write",
      issues: "write",
    });
  });

  it("keeps full final results in run summaries instead of standalone artifacts", () => {
    expect(
      readWorkflow(".github/workflows/investigate.yml").jobs?.investigate?.steps?.find(
        (step) => step.name === "Upload investigation result",
      ),
    ).toBeUndefined();
    expect(
      readWorkflow(".github/workflows/validate.yml").jobs?.validate?.steps?.find(
        (step) => step.name === "Upload validation result",
      ),
    ).toBeUndefined();
  });
});

describe("GitVibe automatic PR review workflow", () => {
  it("keeps PR-open automation in a repo-local wrapper around review.yml", () => {
    const wrapper = readWorkflow(".github/workflows/automatic-pr-review.yml");
    const source = readWorkflow(".github/workflows/review.yml");
    const consumer = readWorkflow("examples/consumer/.github/workflows/review.yml");

    expect(source.on?.pull_request_target).toBeUndefined();
    expect(consumer.on?.pull_request_target).toBeUndefined();
    expect(wrapper.on?.pull_request_target).toMatchObject({
      branches: ["main", "dev"],
      types: ["opened", "reopened", "synchronize", "ready_for_review"],
    });
    expect(wrapper.jobs?.review).toMatchObject({
      if: "${{ !github.event.pull_request.draft }}",
      secrets: {
        GITVIBE_AI_ENV_JSON: "${{ secrets.GITVIBE_AI_ENV_JSON }}",
        GITVIBE_MCP_ENV_JSON: "${{ secrets.GITVIBE_MCP_ENV_JSON }}",
      },
      uses: "./.github/workflows/review.yml",
      with: {
        max_turns: 200,
        "pr-number": "${{ format('{0}', github.event.pull_request.number) }}",
        runner: "docker-runner",
        "source-comment": "",
        timeout_minutes: 60,
      },
    });
    expect(wrapper.jobs?.review?.permissions?.["id-token"]).toBe("write");
  });

  it("cancels older in-progress review runs for the same pull request", () => {
    const source = readWorkflow(".github/workflows/review.yml");
    const wrapper = readWorkflow(".github/workflows/automatic-pr-review.yml");

    expect(source.concurrency).toMatchObject({
      group: "git-vibe-review-${{ inputs.pr-number }}",
      "cancel-in-progress": true,
    });
    expect(wrapper.concurrency).toMatchObject({
      group: "git-vibe-automatic-pr-review-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });
});

/** @param {Workflow} workflow @param {(uses: string) => boolean} matchesUse @returns {SimulatedStep[]} */
function gitVibeActionSteps(workflow, matchesUse) {
  return Object.values(workflow.jobs || {}).flatMap((job) =>
    (job.steps || [])
      .filter((step) => matchesUse(String(step.uses || "")))
      .map((step) => ({
        env: { ...(workflow.env || {}), ...(job.env || {}), ...(step.env || {}) },
        name: step.name,
        uses: step.uses,
        with: step.with,
      })),
  );
}

/** @param {Workflow} workflow @param {string} jobName @param {string} stepName @returns {WorkflowStep | undefined} */
function workflowStep(workflow, jobName, stepName) {
  return workflow.jobs?.[jobName]?.steps?.find((step) => step.name === stepName);
}

/**
 * @param {{ action: string, codexIf: string, job?: WorkflowJob, label: string, claudeIf: string }} options
 */
function expectProviderPrepareBeforeAction(options) {
  const steps = options.job?.steps || [];
  const actionIndex = steps.findIndex((step) => step.uses === options.action);
  const claudeIndex = steps.findIndex((step) => step.name === "Prepare Claude Code executable");
  const codexIndex = steps.findIndex((step) => step.name === "Prepare Codex executable");

  expect(actionIndex, `${options.label} invokes local action`).toBeGreaterThan(-1);
  expect(claudeIndex, `${options.label} prepares Claude`).toBeGreaterThan(-1);
  expect(codexIndex, `${options.label} prepares Codex`).toBeGreaterThan(-1);
  expect(claudeIndex, `${options.label} prepares Claude before action`).toBeLessThan(actionIndex);
  expect(codexIndex, `${options.label} prepares Codex before action`).toBeLessThan(actionIndex);
  expect(steps[claudeIndex], `${options.label} gates Claude setup`).toMatchObject({
    if: options.claudeIf,
    run: "bash .git-vibe/actions/scripts/prepare-claude-code.sh",
  });
  expect(steps[codexIndex], `${options.label} gates Codex setup`).toMatchObject({
    if: options.codexIf,
    run: "bash .git-vibe/actions/scripts/prepare-codex.sh",
  });
}

/** @param {Workflow} workflow @param {string[]} requiredJobs @returns {boolean} */
function workflowJobsHaveIdToken(workflow, requiredJobs) {
  const workflowLevelIdToken = workflow.permissions?.["id-token"] === "write";
  return requiredJobs.every((jobName) => {
    const job = workflow.jobs?.[jobName];
    if (!job) return false;
    return workflowLevelIdToken || job.permissions?.["id-token"] === "write";
  });
}

/** @param {Workflow} workflow @returns {string[]} */
function workflowJobsRequiringIdToken(workflow) {
  return Object.entries(workflow.jobs || {})
    .filter(([, job]) =>
      (job.steps || []).some((step) => String(step.uses || "").startsWith("./.git-vibe/actions/")),
    )
    .map(([jobName]) => jobName);
}

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}

/** @param {string} file @returns {ActionDefinition} */
function readAction(file) {
  return /** @type {ActionDefinition} */ (parse(readFileSync(file, "utf8")));
}
