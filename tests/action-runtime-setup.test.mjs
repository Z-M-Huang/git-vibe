import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ env?: Record<string, string>, id?: string, if?: string, name?: string, run?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} Workflow
 * @typedef {{ inputs?: Record<string, { required?: boolean }>, runs?: { steps?: WorkflowStep[] } }} ActionDefinition
 */

const reusableWorkflows = [
  ".github/workflows/investigate.yml",
  ".github/workflows/materialize.yml",
  ".github/workflows/review.yml",
  ".github/workflows/validate.yml",
];

const actionFiles = [
  "investigate/action.yml",
  "mark-blocked/action.yml",
  "materialize/action.yml",
  "plan-stage/action.yml",
  "review-matrix/action.yml",
  "security-review/action.yml",
  "validate/action.yml",
];

const scrubbedOidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
  ACTIONS_ID_TOKEN_REQUEST_URL: "",
};

describe("GitVibe prebuilt action runtime", () => {
  it("verifies committed runtime bundles without installing dependencies in composite actions", () => {
    for (const file of actionFiles) {
      const action = readAction(file);
      const content = readFileSync(file, "utf8");
      const verifyStep = action.runs?.steps?.find(
        (step) => step.name === "Verify GitVibe action runtime",
      );
      const runEntrypoint = actionEntrypointFor(file);
      const runBundle = runEntrypoint.replace(/\.js$/, ".mjs");
      const runStep = content.lastIndexOf(`node "$GITHUB_ACTION_PATH/../${runEntrypoint}`);
      const verifyIndex = content.indexOf("Verify GitVibe action runtime");

      expect(verifyStep, `${file} verifies prebuilt runtime`).toMatchObject({
        env: scrubbedOidcEnv,
      });
      expect(verifyStep?.run, `${file} checks generated launcher`).toContain(runEntrypoint);
      expect(verifyStep?.run, `${file} checks generated bundle`).toContain(runBundle);
      expect(verifyStep?.run, `${file} reports missing runtime clearly`).toContain(
        "Missing prebuilt GitVibe action runtime",
      );
      expect(content, `${file} should not install dependencies`).not.toContain(
        "install --frozen-lockfile",
      );
      expect(content, `${file} should not declare pnpm setup`).not.toContain("pnpm/action-setup");
      expect(content, `${file} should not run the old runtime build step`).not.toContain(
        "Build GitVibe action runtime",
      );
      expect(content, `${file} should not call removed runtime helper`).not.toContain(
        "ensure-action-runtime",
      );
      expect(content, `${file} should not set up removed AI tooling`).not.toContain("setup-ai-cli");
      expect(verifyIndex, `${file} should verify before running generated entrypoint`).toBeLessThan(
        runStep,
      );
    }
  });

  it("keeps reusable workflow jobs off pnpm and runtime build artifacts", () => {
    for (const file of reusableWorkflows) {
      const workflow = readWorkflow(file);
      const content = readFileSync(file, "utf8");

      expect(workflow.jobs?.["action-runtime"], `${file} has no runtime build job`).toBeUndefined();
      expect(content, `${file} should not install pnpm for local actions`).not.toContain(
        "pnpm/action-setup",
      );
      expect(content, `${file} should not build runtime in consumer workflows`).not.toContain(
        "Build GitVibe action runtime",
      );
      expect(content, `${file} should not upload runtime artifacts`).not.toContain(
        "git-vibe-action-runtime",
      );

      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        const steps = job.steps || [];
        const localActionIndex = steps.findIndex((step) =>
          String(step.uses || "").startsWith("./.git-vibe/actions/"),
        );
        if (localActionIndex === -1) continue;

        const setupSteps = steps.slice(0, localActionIndex);
        const nodeIndex = setupSteps.findIndex((step) => step.uses === "actions/setup-node@v6");
        const pnpmIndex = setupSteps.findIndex((step) => step.uses === "pnpm/action-setup@v6");

        expect(nodeIndex, `${file} ${jobName} installs Node`).toBeGreaterThan(-1);
        expect(pnpmIndex, `${file} ${jobName} should not install pnpm`).toBe(-1);
        expect(setupSteps[nodeIndex], `${file} ${jobName} installs Node 24`).toMatchObject({
          with: { "node-version": 24, "package-manager-cache": false },
        });
      }
    }
  });

  it("prepares the selected safety classifier provider before security review", () => {
    const securityAction = readAction("security-review/action.yml");
    const steps = securityAction.runs?.steps || [];
    const reviewIndex = steps.findIndex((step) => step.id === "review");
    const claudeIndex = steps.findIndex((step) => step.name === "Prepare Claude Code executable");
    const codexIndex = steps.findIndex((step) => step.name === "Prepare Codex executable");

    expect(securityAction.inputs?.adapter).toMatchObject({ required: true });
    expect(claudeIndex).toBeGreaterThan(-1);
    expect(codexIndex).toBeGreaterThan(-1);
    expect(claudeIndex).toBeLessThan(reviewIndex);
    expect(codexIndex).toBeLessThan(reviewIndex);
    expect(steps[claudeIndex]).toMatchObject({
      if: "${{ inputs.adapter == 'claude-code-sdk' }}",
      run: 'bash "$GITHUB_ACTION_PATH/../scripts/prepare-claude-code.sh"',
    });
    expect(steps[codexIndex]).toMatchObject({
      if: "${{ inputs.adapter == 'codex-sdk' }}",
      run: 'bash "$GITHUB_ACTION_PATH/../scripts/prepare-codex.sh"',
    });
  });
});

/** @param {string} file */
function actionEntrypointFor(file) {
  if (file === "mark-blocked/action.yml") return "dist/actions/mark-blocked.js";
  if (file === "plan-stage/action.yml") return "dist/actions/plan-stage.js";
  if (file === "security-review/action.yml") return "dist/actions/security-review.js";
  return "dist/actions/run-action.js";
}

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}

/** @param {string} file @returns {ActionDefinition} */
function readAction(file) {
  return /** @type {ActionDefinition} */ (parse(readFileSync(file, "utf8")));
}
