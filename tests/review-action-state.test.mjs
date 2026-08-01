import { describe, expect, it, vi } from "vitest";
import { runAction } from "../src/runner/actions/run-action.ts";

describe("GitVibe review action state", () => {
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
});
