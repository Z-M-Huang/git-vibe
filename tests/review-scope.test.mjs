import { describe, expect, it, vi } from "vitest";
import { pullRequestReviewFiles } from "../src/runner/review-scope.ts";

/** @typedef {import("../src/shared/github.ts").GitHubClient} GitHubClient */
/** @typedef {import("../src/shared/github.ts").GitHubRequest} GitHubRequest */
/** @typedef {import("../src/shared/types.ts").ReviewRunState} ReviewRunState */

const baseSha = "a".repeat(40);
const reviewedSha = "b".repeat(40);
const canceledSha = "c".repeat(40);
const targetSha = "d".repeat(40);

describe("pull request review scope", () => {
  it("keeps legacy callers on the full pull request without review state", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      if (request.path.startsWith("/repos/example/repo/pulls/12/files?")) {
        return [file("src/legacy.ts")];
      }
      throw new Error(`Unexpected request: ${request.path}`);
    });

    const result = await pullRequestReviewFiles({
      client,
      name: "repo",
      owner: "example",
      pullNumber: "12",
      pullRequest: pullRequest(targetSha),
      reviews: [],
      token: "token",
    });

    expect(result).toEqual({ files: [expect.objectContaining({ filename: "src/legacy.ts" })] });
  });

  it("reviews the full pull request when no completed checkpoint exists", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      if (request.path.startsWith("/repos/example/repo/pulls/12/files?")) {
        return [file("src/full.ts")];
      }
      throw new Error(`Unexpected request: ${request.path}`);
    });

    const result = await reviewFiles({ client, review: {}, reviews: [] });

    expect(result.files.map((item) => item.filename)).toEqual(["src/full.ts"]);
    expect(result.scope).toMatchObject({ baseSha, targetSha });
    expect(result.scope?.checkpointSha).toBeUndefined();
  });

  it("uses the last published result when a newer run was canceled", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      expect(request.path).toBe(`/repos/example/repo/compare/${reviewedSha}...${targetSha}`);
      return { files: [file("src/delta.ts")], status: "ahead" };
    });
    const reviews = [
      completedReview(reviewedSha, "2026-07-01T10:00:00Z"),
      completedReview(canceledSha, "2026-07-01T11:00:00Z", "blocked"),
    ];

    const result = await reviewFiles({ client, review: {}, reviews });

    expect(result.files.map((item) => item.filename)).toEqual(["src/delta.ts"]);
    expect(result.scope).toMatchObject({
      checkpointSha: reviewedSha,
      checkpointSubmittedAt: "2026-07-01T10:00:00Z",
      targetSha,
    });
  });
});

describe("automatic review checkpoint selection", () => {
  it("falls back to the newest completed checkpoint that is an ancestor", async () => {
    const olderSha = "e".repeat(40);
    const request = vi.fn((/** @type {GitHubRequest} */ value) => {
      if (value.path.includes(`${reviewedSha}...${targetSha}`)) {
        return { files: [], status: "diverged" };
      }
      if (value.path.includes(`${olderSha}...${targetSha}`)) {
        return { files: [file("src/from-older.ts")], status: "ahead" };
      }
      throw new Error(`Unexpected request: ${value.path}`);
    });
    const reviews = [
      completedReview(olderSha, "2026-07-01T09:00:00Z"),
      completedReview(reviewedSha, "2026-07-01T10:00:00Z"),
    ];

    const result = await reviewFiles({ client: githubClient(request), review: {}, reviews });

    expect(result.scope?.checkpointSha).toBe(olderSha);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to a full review when GitHub truncates the automatic comparison", async () => {
    const request = vi.fn((/** @type {GitHubRequest} */ value) => {
      if (value.path.includes(`/compare/${reviewedSha}...${targetSha}`)) {
        return {
          files: Array.from({ length: 300 }, (_, index) => file(`src/change-${index}.ts`)),
          status: "ahead",
        };
      }
      if (value.path.startsWith("/repos/example/repo/pulls/12/files?")) {
        return [file("src/full-fallback.ts")];
      }
      throw new Error(`Unexpected request: ${value.path}`);
    });

    const result = await reviewFiles({
      client: githubClient(request),
      review: {},
      reviews: [completedReview(reviewedSha, "2026-07-01T10:00:00Z")],
    });

    expect(result.files.map((item) => item.filename)).toEqual(["src/full-fallback.ts"]);
    expect(result.scope?.checkpointSha).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("frozen review checkpoints", () => {
  it("reconstructs an incremental scope from its frozen checkpoint", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      expect(request.path).toBe(`/repos/example/repo/compare/${reviewedSha}...${targetSha}`);
      return { files: [file("src/delta.ts")], status: "ahead" };
    });
    const reviews = [completedReview(reviewedSha, "2026-07-01T10:00:00Z")];
    const initial = await reviewFiles({ client, review: {}, reviews });

    const reconstructed = await reviewFiles({
      client,
      review: {
        baseSha,
        checkpointSha: reviewedSha,
        snapshotSha: initial.scope?.snapshotSha,
        targetSha,
      },
      reviews,
    });

    expect(reconstructed).toEqual(initial);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it("does not silently change or lose a frozen checkpoint", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      if (request.path.includes(`/compare/${reviewedSha}...${targetSha}`)) {
        return { files: [], status: "diverged" };
      }
      throw new Error(`Unexpected request: ${request.path}`);
    });

    await expect(
      reviewFiles({
        client,
        review: { checkpointSha: reviewedSha, snapshotSha: "1".repeat(64), targetSha },
        reviews: [],
      }),
    ).rejects.toThrow(`Completed review checkpoint ${reviewedSha} is no longer available`);

    await expect(
      reviewFiles({
        client,
        review: { checkpointSha: reviewedSha, targetSha },
        reviews: [completedReview(reviewedSha, "2026-07-01T10:00:00Z")],
      }),
    ).rejects.toThrow("A frozen review checkpoint requires a snapshot SHA");

    await expect(
      reviewFiles({
        client,
        review: { checkpointSha: reviewedSha, snapshotSha: "1".repeat(64), targetSha },
        reviews: [completedReview(reviewedSha, "2026-07-01T10:00:00Z")],
      }),
    ).rejects.toThrow(`Review checkpoint ${reviewedSha} is not an ancestor of target ${targetSha}`);
  });
});

describe("review scope validation", () => {
  it("rejects malformed comparison responses instead of reviewing an incomplete delta", async () => {
    const client = githubClient(() => ({ status: "ahead" }));

    await expect(
      reviewFiles({
        client,
        review: {},
        reviews: [completedReview(reviewedSha, "2026-07-01T10:00:00Z")],
      }),
    ).rejects.toThrow("GitHub compare response was missing changed files");
  });

  it("accepts a completed review at the current target as an empty delta", async () => {
    const client = githubClient(() => {
      throw new Error("The compare endpoint should not be called for identical SHAs.");
    });

    const result = await reviewFiles({
      client,
      review: {},
      reviews: [completedReview(targetSha, "2026-07-01T10:00:00Z")],
    });

    expect(result.files).toEqual([]);
    expect(result.scope?.checkpointSha).toBe(targetSha);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("keeps an initial full scope frozen when a checkpoint appears between jobs", async () => {
    const client = githubClient((/** @type {GitHubRequest} */ request) => {
      if (request.path.startsWith("/repos/example/repo/pulls/12/files?")) {
        return [file("src/full.ts")];
      }
      throw new Error(`Unexpected request: ${request.path}`);
    });
    const initial = await reviewFiles({ client, review: {}, reviews: [] });

    const reconstructed = await reviewFiles({
      client,
      review: {
        baseSha,
        snapshotSha: initial.scope?.snapshotSha,
        targetSha,
      },
      reviews: [completedReview(reviewedSha, "2026-07-01T10:00:00Z")],
    });

    expect(reconstructed.scope?.checkpointSha).toBeUndefined();
    expect(reconstructed.scope?.snapshotSha).toBe(initial.scope?.snapshotSha);
  });

  it("rejects a frozen review after the pull request head changes", async () => {
    const client = githubClient(() => []);

    await expect(
      pullRequestReviewFiles({
        client,
        name: "repo",
        owner: "example",
        pullNumber: "12",
        pullRequest: pullRequest("f".repeat(40)),
        review: { snapshotSha: "1".repeat(64), targetSha },
        reviews: [],
        token: "token",
      }),
    ).rejects.toThrow(`Review target ${targetSha} was superseded`);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects a frozen review after the pull request base changes", async () => {
    const client = githubClient(() => []);
    const previousBase = "e".repeat(40);

    await expect(
      reviewFiles({ client, review: { baseSha: previousBase, targetSha }, reviews: [] }),
    ).rejects.toThrow(`Review base ${previousBase} was superseded by pull request base ${baseSha}`);
    expect(client.request).not.toHaveBeenCalled();
  });
});

/**
 * @param {{ client: GitHubClient; review: ReviewRunState; reviews: any[] }} options
 */
function reviewFiles({ client, review, reviews }) {
  return pullRequestReviewFiles({
    client,
    name: "repo",
    owner: "example",
    pullNumber: "12",
    pullRequest: pullRequest(targetSha),
    review,
    reviews,
    token: "token",
  });
}

/** @param {string} headSha */
function pullRequest(headSha) {
  return {
    base: { sha: baseSha },
    head: { repo: { full_name: "contributor/repo" }, sha: headSha },
  };
}

/** @param {string} headSha @param {string} submittedAt @param {string} [status] */
function completedReview(headSha, submittedAt, status = "completed") {
  return {
    body: [
      `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 review-version=1 base-sha=${baseSha} head-sha=${headSha} snapshot-sha=${"1".repeat(64)} -->`,
      `**Status:** \`${status}\``,
    ].join("\n"),
    submitted_at: submittedAt,
    user: { login: "gitvibe-for-github[bot]" },
  };
}

/** @param {string} filename */
function file(filename) {
  return {
    additions: 1,
    changes: 1,
    deletions: 0,
    filename,
    patch: "@@ -0,0 +1 @@\n+change",
    status: "modified",
  };
}

/**
 * @param {((request: GitHubRequest) => any) | ReturnType<typeof vi.fn>} response
 * @returns {GitHubClient}
 */
function githubClient(response) {
  const request = "mock" in response ? response : vi.fn(response);
  return /** @type {GitHubClient} */ (/** @type {unknown} */ ({ request }));
}
