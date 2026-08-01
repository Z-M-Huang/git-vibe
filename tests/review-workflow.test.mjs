import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * @typedef {{ env?: Record<string, unknown>, steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{ env?: Record<string, unknown>, name?: string, uses?: string, with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} Workflow
 */

describe("GitVibe review workflow finalizer", () => {
  it("fails on blocked and changes-required review results", () => {
    const workflow = /** @type {Workflow} */ (
      parse(readFileSync(".github/workflows/review.yml", "utf8"))
    );
    const reviewStep = workflow.jobs?.["review-matrix"]?.steps?.find(
      (step) => step.uses === "./.git-vibe/actions/review-matrix",
    );

    expect(reviewStep?.with).toMatchObject({
      "fail-on-blocked": "true",
      "fail-on-changes-required": "true",
    });
  });

  it("freezes review scope internally without exposing review controls", () => {
    const workflow = /** @type {Workflow} */ (
      parse(readFileSync(".github/workflows/review.yml", "utf8"))
    );
    const memberJob = workflow.jobs?.["review-matrix-members"];
    const securityStep = workflow.jobs?.["security-review"]?.steps?.find(
      (step) => step.uses === "./.git-vibe/actions/security-review",
    );
    const snapshotCheckout = memberJob?.steps?.find(
      (step) => step.name === "Checkout immutable review snapshot",
    );
    const reviewAction = parse(readFileSync("review-matrix/action.yml", "utf8"));
    const securityAction = parse(readFileSync("security-review/action.yml", "utf8"));

    expect(reviewAction.inputs).not.toHaveProperty("review-mode");
    expect(reviewAction.inputs).not.toHaveProperty("target-sha");
    expect(securityAction.inputs).not.toHaveProperty("target-sha");
    expect(securityStep?.env).toMatchObject({
      GITVIBE_REVIEW_EVENT_TARGET_SHA: "${{ github.event.pull_request.head.sha || '' }}",
    });
    expect(memberJob?.env).toMatchObject({
      GITVIBE_REVIEW_CHECKPOINT_SHA: "${{ needs.security-review.outputs.checkpoint-sha }}",
      GITVIBE_REVIEW_TARGET_SHA: "${{ needs.security-review.outputs.target-sha }}",
    });
    expect(snapshotCheckout?.with).toMatchObject({
      path: ".git-vibe/review-snapshot",
      ref: "${{ needs.security-review.outputs.target-sha }}",
      repository: "${{ needs.security-review.outputs.head-repository }}",
    });
  });
});
