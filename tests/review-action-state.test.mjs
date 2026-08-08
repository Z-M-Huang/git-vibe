import { describe, expect, it, vi } from "vitest";
import { runAction } from "../src/runner/actions/run-action.ts";

describe("GitVibe review action state", () => {
  it("keeps completed changes-required review finalization successful by default", async () => {
    const error = vi.fn();
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "Changes required.",
      parsedOutput: { next_state: "changes-required" },
      schemaId: "review-matrix.v1",
      status: "completed",
      summary: "Changes required.",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["review-matrix"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_EXECUTION_MODE: "finalizer",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_ISSUE_NUMBER: "12",
        },
        error,
        runStage,
      }),
    ).resolves.toBe(0);

    expect(error).not.toHaveBeenCalled();
  });

  it("passes frozen scope from internal workflow environment without a mode", async () => {
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "review-matrix.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });
    const review = {
      baseSha: "a".repeat(40),
      checkpointSha: "b".repeat(40),
      inputSafetyDigest: "c".repeat(64),
      snapshotSha: "d".repeat(64),
      targetSha: "e".repeat(40),
    };

    await expect(
      runAction({
        argv: ["review-matrix"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_INPUT_SAFETY_DIGEST: review.inputSafetyDigest,
          GITVIBE_ISSUE_NUMBER: "12",
          GITVIBE_REVIEW_BASE_SHA: review.baseSha,
          GITVIBE_REVIEW_CHECKPOINT_SHA: review.checkpointSha,
          GITVIBE_REVIEW_SNAPSHOT_SHA: review.snapshotSha,
          GITVIBE_REVIEW_TARGET_SHA: review.targetSha,
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage).toHaveBeenCalledWith(expect.objectContaining({ review }));
    expect(runStage.mock.calls[0][0].review).not.toHaveProperty("mode");
  });

  it("does not pass review state to non-review stages", async () => {
    const runStage = vi.fn().mockResolvedValue({
      commentBody: "",
      parsedOutput: {},
      schemaId: "validate.v1",
      status: "completed",
      summary: "Done",
      validationErrors: [],
    });

    await expect(
      runAction({
        argv: ["validate"],
        env: {
          GITHUB_REPOSITORY: "example/repo",
          GITVIBE_GITHUB_APP_TOKEN: "token",
          GITVIBE_INPUT_SAFETY_DIGEST: "c".repeat(64),
          GITVIBE_ISSUE_NUMBER: "12",
          GITVIBE_REVIEW_BASE_SHA: "a".repeat(40),
          GITVIBE_REVIEW_CHECKPOINT_SHA: "b".repeat(40),
          GITVIBE_REVIEW_SNAPSHOT_SHA: "d".repeat(64),
          GITVIBE_REVIEW_TARGET_SHA: "e".repeat(40),
        },
        runStage,
      }),
    ).resolves.toBe(0);

    expect(runStage.mock.calls[0][0]).not.toHaveProperty("review");
  });
});
