import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ id?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ if?: string, needs?: string | string[], outputs?: Record<string, string>, permissions?: Record<string, string>, steps?: WorkflowStep[], ["timeout-minutes"]?: string | number }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} Workflow
 */

/** @type {Array<[string, string, string, string]>} */
const specs = [
  [".github/workflows/investigate.yml", "plan-investigate", "investigate-members", "investigate"],
  [".github/workflows/materialize.yml", "plan-materialize", "materialize", "materialize"],
  [".github/workflows/review.yml", "plan-review-matrix", "review-matrix-members", "review-matrix"],
  [".github/workflows/validate.yml", "plan-validate", "validate-members", "validate"],
];

describe("GitVibe workflow security review topology", () => {
  it("plans the safety adapter before security review and gates stage LLM jobs", () => {
    for (const [file, planJobName, firstLlmJobName, securityStage] of specs) {
      const workflow = readWorkflow(file);
      const planJob = workflow.jobs?.[planJobName];
      const securityReview = workflow.jobs?.["security-review"];
      const securityStep = securityReview?.steps?.find(
        (step) => step.uses === "./.git-vibe/actions/security-review",
      );
      const firstLlmJob = workflow.jobs?.[firstLlmJobName];

      expect(planJob, `${file} declares deterministic planning before security`).toMatchObject({
        outputs: expect.objectContaining({
          "safety-adapter": "${{ steps.plan.outputs.safety-adapter }}",
        }),
        permissions: expect.objectContaining({ contents: "read" }),
        "timeout-minutes": 10,
      });
      expect(securityReview, `${file} declares a security-review job`).toMatchObject({
        needs: planJobName,
        outputs: expect.objectContaining({
          allowed: "${{ steps.security.outputs.allowed }}",
          status: "${{ steps.security.outputs.status }}",
        }),
        permissions: expect.objectContaining({ contents: "read" }),
        "timeout-minutes": "${{ fromJSON(inputs.timeout_minutes) }}",
      });
      expect(securityStep, `${file} runs the security review action`).toMatchObject({
        id: "security",
        with: expect.objectContaining({
          adapter: `\${{ needs.${planJobName}.outputs.safety-adapter }}`,
          stage: securityStage,
        }),
      });
      expect(firstLlmJob?.needs, `${file} gates ${firstLlmJobName}`).toEqual(
        expect.arrayContaining([planJobName, "security-review"]),
      );
      expect(firstLlmJob?.if, `${file} checks security allowed output`).toContain(
        "needs.security-review.outputs.allowed == 'true'",
      );
    }
  });
});

/** @param {string} file @returns {Workflow} */
function readWorkflow(file) {
  return /** @type {Workflow} */ (parse(readFileSync(file, "utf8")));
}
