import { describe, expect, it, vi } from "vitest";
import { buildIssueContext, contextForStage } from "../src/runner/context.ts";

/** @typedef {import("../src/shared/github.ts").GitHubClient} GitHubClient */
/** @typedef {import("../src/shared/github.ts").GitHubRequest} GitHubRequest */

const baseSha = "a".repeat(40);
const checkpointSha = "b".repeat(40);
const targetSha = "c".repeat(40);

describe("incremental review context", () => {
  it("rejects review state without a pull request target", async () => {
    const client = githubClient(() => {
      throw new Error("Context loading should not start.");
    });

    await expect(
      contextForStage(client, {
        cwd: "/repo",
        dryRun: false,
        issueNumber: "4",
        maxTurns: 1,
        prNumber: "",
        repository: "example/repo",
        review: { targetSha },
        stage: "review-matrix",
        stageTimeoutMinutes: 1,
        token: "token",
      }),
    ).rejects.toThrow("review-matrix requires a pull request target");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("omits superseded GitVibe review bodies but retains human context", async () => {
    const client = githubClient((request) => {
      if (request.path === "/repos/example/repo/issues/4") return issue();
      if (request.path.startsWith("/repos/example/repo/issues/4/comments?")) return [];
      if (request.path === "/repos/example/repo/pulls/4") return pullRequest();
      if (request.path.startsWith("/repos/example/repo/pulls/4/reviews?")) return reviews();
      if (request.path.includes(`/compare/${checkpointSha}...${targetSha}`)) {
        return { files: [changedFile()], status: "ahead" };
      }
      throw new Error(`Unexpected request: ${request.path}`);
    });

    const context = await buildIssueContext({
      client,
      issueNumber: "4",
      repository: "example/repo",
      review: {},
      token: "token",
      type: "pull-request",
    });

    const bodies = context.timeline.map((item) => item.body);
    expect(bodies.some((body) => body.includes("Old GitVibe result"))).toBe(false);
    expect(bodies.some((body) => body.includes("Checkpoint result"))).toBe(true);
    expect(bodies).toContain("Human review context");
  });
});

function reviews() {
  return [
    gitVibeReview("d".repeat(40), "2026-01-01T00:00:00Z", "Old GitVibe result"),
    gitVibeReview(checkpointSha, "2026-01-02T00:00:00Z", "Checkpoint result"),
    {
      body: "Human review context",
      submitted_at: "2026-01-01T12:00:00Z",
      user: { login: "reviewer" },
    },
  ];
}

/** @param {string} headSha @param {string} submittedAt @param {string} detail */
function gitVibeReview(headSha, submittedAt, detail) {
  const marker = `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=4 review-version=1 base-sha=${baseSha} head-sha=${headSha} snapshot-sha=${"1".repeat(64)} -->`;
  return {
    body: `${marker}\n**Status:** \`completed\`\n${detail}`,
    submitted_at: submittedAt,
    user: { login: "gitvibe-for-github[bot]" },
  };
}

function issue() {
  return {
    body: "Pull request body",
    created_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/example/repo/pull/4",
    number: 4,
    title: "Pull request",
    user: { login: "author" },
  };
}

function pullRequest() {
  return {
    base: { sha: baseSha },
    head: { ref: "feature", repo: { full_name: "contributor/repo" }, sha: targetSha },
  };
}

function changedFile() {
  return { filename: "src/app.ts", patch: "@@ -1 +1 @@\n-old\n+new", status: "modified" };
}

/** @param {(request: GitHubRequest) => any} request @returns {GitHubClient} */
function githubClient(request) {
  return /** @type {GitHubClient} */ (
    /** @type {unknown} */ ({
      graphql: vi.fn().mockResolvedValue({
        repository: { pullRequest: { reviewThreads: { nodes: [] } } },
      }),
      request: vi.fn(request),
    })
  );
}
