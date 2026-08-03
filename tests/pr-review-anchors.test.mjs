import { describe, expect, it, vi } from "vitest";
import { publishPullRequestReviewResult } from "../src/runner/pr-review-publishing.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 * @typedef {import("../src/runner/pr-review-github.ts").PullRequestReviewComment} PullRequestReviewComment
 */

describe("pull request review anchor validation ranges", () => {
  it("downgrades ranges that start before the modified diff hunk", async () => {
    const client = createClient({ files: pr35Files() });
    const logger = createLogger();

    await publishPullRequestReviewResult({
      client,
      context: context(),
      logger,
      parsedOutput: {
        ...output(),
        inline_comments: [
          { body: "Server startup gate.", line: 428, path: "cmd/server/main.go", start_line: 422 },
          {
            body: "Demo startup gate.",
            line: 405,
            path: "cmd/demo-server/main.go",
            start_line: 399,
          },
          {
            body: "Fact status guard.",
            line: 85,
            path: "internal/service/recallservice/community_expansion.go",
            start_line: 82,
          },
          {
            body: "Claim status guard.",
            line: 154,
            path: "internal/service/recallservice/community_expansion.go",
            start_line: 151,
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
      stageResultBody: "Review summary.",
    });

    const comments = reviewRequest(client).body.comments || [];
    expect(comments).toHaveLength(4);
    expect(comments.find((comment) => comment.path === "cmd/server/main.go")).not.toHaveProperty(
      "start_line",
    );
    expect(
      comments.find((comment) => comment.path === "cmd/demo-server/main.go"),
    ).not.toHaveProperty("start_line");
    expect(
      comments.find(
        (comment) =>
          comment.path === "internal/service/recallservice/community_expansion.go" &&
          comment.line === 85,
      ),
    ).toMatchObject({ start_line: 82 });
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.anchors.checked", {
      comments: 4,
      downgraded: 2,
      posted: 4,
      unanchored: 0,
    });
  });
});

describe("pull request review anchor validation reversed ranges", () => {
  it("downgrades reversed ranges before creating the review", async () => {
    const client = createClient({
      files: [
        {
          filename: "src/app.ts",
          patch: "@@ -0,0 +155,2 @@\n+line 155\n+line 156",
        },
      ],
    });
    const logger = createLogger();

    await publishPullRequestReviewResult({
      client,
      context: context(),
      logger,
      parsedOutput: {
        ...output(),
        inline_comments: [
          {
            body: "Reversed range.",
            line: 155,
            path: "src/app.ts",
            start_line: 156,
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
      stageResultBody: "Review summary.",
    });

    expect(reviewRequest(client).body.comments).toEqual([
      expect.objectContaining({ line: 155, path: "src/app.ts", side: "RIGHT" }),
    ]);
    expect(reviewRequest(client).body.comments?.[0]).not.toHaveProperty("start_line");
    expect(reviewRequest(client).body.comments?.[0]).not.toHaveProperty("start_side");
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.anchors.checked", {
      comments: 1,
      downgraded: 1,
      posted: 1,
      unanchored: 0,
    });
  });
});

describe("pull request review anchor validation unanchored lines", () => {
  it("keeps left-side comments on deleted lines", async () => {
    const client = createClient({
      files: [
        {
          filename: "src/app.ts",
          patch: "@@ -10,3 +10,2 @@\n keep\n-removed\n keep",
        },
      ],
    });

    await publishPullRequestReviewResult({
      client,
      context: context(),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        inline_comments: [
          { body: "Deleted-line finding.", line: 11, path: "src/app.ts", side: "LEFT" },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
      stageResultBody: "Review summary.",
    });

    expect(reviewRequest(client).body.comments).toEqual([
      expect.objectContaining({ line: 11, path: "src/app.ts", side: "LEFT" }),
    ]);
  });

  it("moves comments with unresolved lines into the review body", async () => {
    const client = createClient({
      files: [
        {
          filename: "src/app.ts",
          patch: "@@ -40,3 +40,4 @@\n line 40\n line 41\n+line 42\n line 43",
        },
      ],
    });

    await publishPullRequestReviewResult({
      client,
      context: context(),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        inline_comments: [
          {
            body: "Anchored finding.",
            finding_id: "anchored-finding",
            line: 42,
            path: "src/app.ts",
          },
          {
            body: "Unanchored finding.",
            finding_id: "unanchored-finding",
            line: 99,
            path: "src/app.ts",
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
      stageResultBody: "Review summary.",
    });

    const review = reviewRequest(client);
    expect(review.body.comments).toHaveLength(1);
    expect(review.body.body).toContain("### Unanchored Inline Findings");
    expect(review.body.body).toContain("`src/app.ts:99` (line is not in the pull request diff)");
    expect(review.body.body).toContain(
      "<!-- git-vibe:review-finding-unanchored id=unanchored-finding -->",
    );
    expect(review.body.body).toContain("Unanchored finding.");
  });
});

describe("pull request review anchor validation lookup failures", () => {
  it("posts a top-level review when patch lookup fails", async () => {
    const client = createClient({ filesError: new Error("files unavailable") });
    const logger = createLogger();

    await publishPullRequestReviewResult({
      client,
      context: context(),
      logger,
      parsedOutput: {
        ...output(),
        inline_comments: [
          {
            body: "Could not validate this anchor.",
            finding_id: "anchor-lookup-failure",
            line: 42,
            path: "src/app.ts",
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner(),
      stageResultBody: "Review summary.",
    });

    const review = reviewRequest(client);
    expect(review.body.comments).toBeUndefined();
    expect(review.body.body).toContain("`src/app.ts:42` (patch lookup failed)");
    expect(review.body.body).toContain(
      "<!-- git-vibe:review-finding-unanchored id=anchor-lookup-failure -->",
    );
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.anchors.lookup.failed", {
      comments: 1,
      error: expect.stringContaining("files unavailable"),
    });
  });
});

function pr35Files() {
  return [
    {
      filename: "cmd/server/main.go",
      patch:
        '@@ -423,6 +425,8 @@ func main() {\n \tcommunityProbeCancel()\n \tif communityAvailable {\n \t\tcommunityDetectRegistrySvc = communityservice.NewLeidenService(pgDB.GetDB(), neo4jClient, &cfg, slog.Default())\n+\t} else {\n+\t\tslog.Default().Warn("community scheduler: GDS unavailable, scheduler not started")\n \t}',
    },
    {
      filename: "cmd/demo-server/main.go",
      patch:
        '@@ -400,6 +402,8 @@ func main() {\n \tcommunityProbeCancel()\n \tif communityAvailable {\n \t\tcommunityDetectRegistrySvc = communityservice.NewLeidenService(pgDB.GetDB(), neo4jClient, &cfg, slog.Default())\n+\t} else {\n+\t\tslog.Default().Warn("community scheduler: GDS unavailable, scheduler not started")\n \t}',
    },
    {
      filename: "internal/service/recallservice/community_expansion.go",
      patch: `@@ -0,0 +1,160 @@\n${Array.from({ length: 160 }, (_, index) => `+line ${index + 1}`).join("\n")}`,
    },
  ];
}

/** @returns {Record<string, unknown>} */
function output() {
  return {
    assumptions: [],
    findings: [],
    next_state: "ready-for-materialization",
    references: [],
    stage: "materialize",
    status: "completed",
    summary: "Result summary.",
  };
}

/** @returns {ContextPacket} */
function context() {
  return /** @type {ContextPacket} */ ({
    artifact: {
      body: "Body",
      number: "12",
      title: "Title",
      type: "pull-request",
      url: "https://github.com/example/repo/pulls/12",
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  });
}

/** @returns {RunnerOptions} */
function runner() {
  return /** @type {RunnerOptions} */ ({
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "review-matrix",
    stageTimeoutMinutes: 1,
    token: "token",
  });
}

/**
 * @param {{ files?: unknown[]; filesError?: Error }} [options]
 * @returns {MockGitHubClient}
 */
function createClient(options = {}) {
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(
      /**
       * @param {any} request
       */
      async (request) => {
        if (request.path.startsWith("/repos/example/repo/pulls/12/files")) {
          if (options.filesError) throw options.filesError;
          return options.files || [];
        }
        return {};
      },
    ),
    retryBaseDelayMs: 0,
  });
}

function createLogger() {
  return {
    event: vi.fn(),
  };
}

/**
 * @param {MockGitHubClient} client
 * @returns {{ body: { body: string; comments?: PullRequestReviewComment[] } }}
 */
function reviewRequest(client) {
  return client.request.mock.calls
    .map(
      /**
       * @param {any[]} call
       */
      (call) => call[0],
    )
    .find(
      /**
       * @param {any} request
       */
      (request) => request.path.endsWith("/pulls/12/reviews"),
    );
}
