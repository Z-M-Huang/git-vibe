import { describe, expect, it, vi } from "vitest";
import { assertCurrentReviewTarget } from "../src/runner/review-target.ts";

/** @typedef {import("../src/shared/github.ts").GitHubClient} GitHubClient */
/** @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket */
/** @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions */

const targetSha = "a".repeat(40);

describe("review publication target", () => {
  it("allows writes only while the pull request still points at the frozen target", async () => {
    const client = githubClient(targetSha);

    await expect(
      assertCurrentReviewTarget({ client, context: context(), runner: runner() }),
    ).resolves.toBeUndefined();
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/repos/example/repo/pulls/12" }),
    );
  });

  it("rejects stale writes after a new commit arrives", async () => {
    const currentSha = "b".repeat(40);
    const client = githubClient(currentSha);

    await expect(
      assertCurrentReviewTarget({ client, context: context(), runner: runner() }),
    ).rejects.toThrow(
      `Review target ${targetSha} was superseded by pull request head ${currentSha}`,
    );
  });
});

/** @returns {ContextPacket} */
function context() {
  return {
    artifact: {
      body: "Body",
      number: "12",
      title: "Pull request",
      type: "pull-request",
      url: "https://github.com/example/repo/pull/12",
    },
    generatedAt: "2026-08-01T00:00:00Z",
    repository: "example/repo",
    reviewScope: {
      baseSha: "c".repeat(40),
      headRepository: "contributor/repo",
      snapshotSha: "d".repeat(64),
      targetSha,
    },
    timeline: [],
  };
}

/** @returns {RunnerOptions} */
function runner() {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 1,
    prNumber: "12",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
  };
}

/** @param {string} headSha @returns {GitHubClient} */
function githubClient(headSha) {
  return /** @type {GitHubClient} */ (
    /** @type {unknown} */ ({ request: vi.fn().mockResolvedValue({ head: { sha: headSha } }) })
  );
}
