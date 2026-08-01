import { describe, expect, it, vi } from "vitest";
import {
  reuseReviewInputSafetyAttestation,
  securityReviewResultWithAttestation,
} from "../src/runner/review-safety-attestation.ts";

/** @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket */
/** @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions */

describe("review input safety attestation", () => {
  it("reuses the security job result only for identical review context", () => {
    const context = reviewContext("safe change");
    const attested = securityReviewResultWithAttestation({
      config: {},
      context,
      result: { allowed: true, status: "allowed", summary: "Passed." },
    });
    const logger = { event: vi.fn() };
    /** @type {RunnerOptions} */
    const runner = {
      cwd: "/repo",
      dryRun: false,
      issueNumber: "12",
      maxTurns: 1,
      prNumber: "12",
      repository: "example/repo",
      review: { inputSafetyDigest: attested.inputSafetyDigest },
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    };

    expect(reuseReviewInputSafetyAttestation({ config: {}, context, logger, runner })).toBe(true);
    expect(
      reuseReviewInputSafetyAttestation({
        config: {},
        context: reviewContext("changed after security review"),
        logger,
        runner,
      }),
    ).toBe(false);
    expect(attested.reviewScope).toBe(context.reviewScope);
    expect(logger.event).toHaveBeenCalledWith(
      "safety.input_attestation.reused",
      expect.objectContaining({ digest: attested.inputSafetyDigest }),
    );
    expect(logger.event).toHaveBeenCalledWith(
      "safety.input_attestation.mismatch",
      expect.objectContaining({ expected_digest: attested.inputSafetyDigest }),
    );
  });
});

/** @param {string} patch @returns {ContextPacket} */
function reviewContext(patch) {
  return {
    artifact: {
      body: "Body",
      number: "12",
      title: "Pull request",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/12",
    },
    generatedAt: "2026-08-01T00:00:00Z",
    pullRequestFiles: [{ filename: "src/app.ts", patch, status: "modified" }],
    repository: "example/repo",
    reviewScope: {
      baseSha: "a".repeat(40),
      headRepository: "contributor/repo",
      snapshotSha: "b".repeat(64),
      targetSha: "c".repeat(40),
    },
    timeline: [],
  };
}
