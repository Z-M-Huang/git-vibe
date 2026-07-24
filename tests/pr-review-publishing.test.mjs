import { describe, expect, it, vi } from "vitest";
import { publishPullRequestReviewResult } from "../src/runner/pr-review-publishing.ts";
import { publishStageResultComment } from "../src/runner/stage-publishing.ts";

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket
 * @typedef {import("../src/shared/types.ts").RunnerOptions} RunnerOptions
 */

describe("pull request review publishing", () => {
  it("submits review-matrix required fixes as GitHub pull request review comments", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["src/app.ts:42 fails when the webhook label arrives on pull_request."],
        inline_comments: [
          {
            body: "This branch misses `pull_request.labeled`, so review labels on PRs never start review.",
            line: 42,
            path: "src/app.ts",
            severity: "high",
          },
          {
            body: "The range should share the same right-side anchor.",
            line: 48,
            path: "src/app.ts",
            start_line: 46,
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
        summary: "Review found required changes.",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review).toMatchObject({
      body: {
        body: expect.stringContaining(
          "<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 run=99 -->",
        ),
        comments: [
          {
            body: expect.stringContaining("pull_request.labeled"),
            line: 42,
            path: "src/app.ts",
            side: "RIGHT",
          },
          {
            body: expect.stringContaining("The range should share the same right-side anchor."),
            line: 48,
            path: "src/app.ts",
            side: "RIGHT",
            start_line: 46,
            start_side: "RIGHT",
          },
        ],
        event: "COMMENT",
      },
      method: "POST",
      path: "/repos/example/repo/pulls/12/reviews",
    });
    expect(review.body.body).toContain("Review found required changes.");
    expect(review.body.body).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/99",
    );
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/issues/12/comments",
    );
  });
});

describe("pull request review publishing inline anchor errors", () => {
  it("surfaces GitHub validation errors when inline anchors are rejected", async () => {
    const client = createClient({ unresolvedReviewLineError: true });
    const logger = createLogger();

    await expect(
      publishStageResultComment({
        client,
        context: context("pull-request"),
        logger,
        parsedOutput: {
          ...output(),
          findings: ["src/app.ts:42 is not anchorable in the current pull request diff."],
          inline_comments: [
            {
              body: "This generated inline anchor cannot be resolved by GitHub.",
              line: 42,
              path: "src/app.ts",
            },
          ],
          next_state: "changes-required",
          stage: "review-matrix",
        },
        runner: runner({ stage: "review-matrix" }),
      }),
    ).rejects.toThrow("Line could not be resolved");

    const reviews = requestCalls(client).filter((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].body.comments).toHaveLength(1);
    expect(logger.event).not.toHaveBeenCalledWith("github.pr.review.done", expect.anything());
  });
});

describe("pull request review publishing passed reviews", () => {
  it("submits a top-level pull request review when review-matrix passes", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({ stage: "review-matrix" }),
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review.body).toMatchObject({
      body: expect.stringContaining("**Next state:** `review-passed`"),
      comments: undefined,
      event: "COMMENT",
    });
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/issues/12/comments",
    );
  });

  it("adds the workflow run URL when a supplied review body omits it", async () => {
    const client = createClient();

    await publishPullRequestReviewResult({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: { ...output(), next_state: "review-passed", stage: "review-matrix" },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
      stageResultBody: "Review summary without run.",
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review.body.body).toContain("Review summary without run.");
    expect(review.body.body).toContain(
      "Workflow run: https://github.com/example/repo/actions/runs/99",
    );
  });
});

describe("pull request review publishing reruns", () => {
  it("updates a matching top-level review result from the same workflow run", async () => {
    const client = createClient();
    const logger = createLogger();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview(),
      logger,
      parsedOutput: {
        ...output(),
        findings: ["The same blocked result was already published by an earlier attempt."],
        next_state: "blocked",
        stage: "review-matrix",
        status: "blocked",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(requestCalls(client)).toContainEqual(
      expect.objectContaining({
        body: {
          body: expect.stringContaining(
            "The same blocked result was already published by an earlier attempt.",
          ),
        },
        method: "PUT",
        path: "/repos/example/repo/pulls/12/reviews/99",
      }),
    );
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/issues/12/comments",
    );
    expect(requestCalls(client)).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/user" }),
    );
    expect(requestCalls(client).map((request) => request.method)).not.toContain("POST");
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.update.start", {
      pull_request: "12",
      review: "99",
      run: "99",
    });
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.update.done", {
      pull_request: "12",
      review: "99",
      run: "99",
    });
  });
});

describe("pull request review publishing rerun ownership guards", () => {
  it("submits a new review when a matching rerun review is not authored by the token user", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview({ author: "contributor" }),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(requestCalls(client)).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/user" }),
    );
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/reviews/99",
    );
    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews")),
    ).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/repos/example/repo/pulls/12/reviews",
      }),
    );
  });

  it("submits a new review when the token author cannot be identified", async () => {
    const client = createClient({ userLookupError: true });
    const logger = createLogger();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview(),
      logger,
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(requestCalls(client)).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/user" }),
    );
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/reviews/99",
    );
    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews")),
    ).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/repos/example/repo/pulls/12/reviews",
      }),
    );
    expect(logger.event).toHaveBeenCalledWith("github.pr.review.update.skip", {
      reason: "unknown-token-author",
    });
  });
});

describe("pull request review publishing legacy reruns", () => {
  it("updates the latest matching legacy review that only references the workflow run in body", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: {
        ...context("pull-request"),
        timeline: [
          previousReview({
            body: previousReviewBody([], { includeRunAttribute: false }),
            databaseId: 88,
            id: "older-review-node",
          }),
          previousReview({
            body: previousReviewBody([], { includeRunAttribute: false }),
            databaseId: 99,
          }),
        ],
      },
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews/99")),
    ).toEqual(
      expect.objectContaining({
        method: "PUT",
        path: "/repos/example/repo/pulls/12/reviews/99",
      }),
    );
    expect(requestCalls(client).map((request) => request.path)).not.toContain(
      "/repos/example/repo/pulls/12/reviews/88",
    );
  });
});

describe("pull request review publishing changed rerun outcomes", () => {
  it("updates the existing review when a rerun changes the review result outcome", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview(),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews/99")),
    ).toEqual(
      expect.objectContaining({
        body: { body: expect.stringContaining("**Next state:** `review-passed`") },
        method: "PUT",
        path: "/repos/example/repo/pulls/12/reviews/99",
      }),
    );
  });
});

describe("pull request review publishing rerun inline comment guards", () => {
  it("submits a new review when rerun output includes inline comments", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview(),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["New required fix."],
        inline_comments: [
          {
            body: "New line-specific feedback.",
            line: 42,
            path: "src/app.ts",
          },
        ],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews")),
    ).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          comments: [
            {
              body: expect.stringContaining("New line-specific feedback."),
              line: 42,
              path: "src/app.ts",
              side: "RIGHT",
            },
          ],
        }),
        method: "POST",
        path: "/repos/example/repo/pulls/12/reviews",
      }),
    );
  });

  it("submits a new review when the matching review already has inline comments", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: contextWithPreviousReview({
        body: previousReviewBody(["**Inline comments:** 1"]),
      }),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        next_state: "review-passed",
        stage: "review-matrix",
      },
      runner: runner({
        stage: "review-matrix",
        workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
      }),
    });

    expect(
      requestCalls(client).find((request) => request.path.endsWith("/pulls/12/reviews")),
    ).toEqual(
      expect.objectContaining({
        method: "POST",
        path: "/repos/example/repo/pulls/12/reviews",
      }),
    );
  });
});

describe("pull request review publishing validation", () => {
  it("submits a top-level pull request review when required fixes are not anchorable", async () => {
    const client = createClient();

    await publishStageResultComment({
      client,
      context: context("pull-request"),
      logger: createLogger(),
      parsedOutput: {
        ...output(),
        findings: ["The PR misses the workflow trigger, but the finding is not line-anchored."],
        next_state: "changes-required",
        stage: "review-matrix",
      },
      runner: runner({ stage: "review-matrix" }),
    });

    const review = requestCalls(client).find((request) =>
      request.path.endsWith("/pulls/12/reviews"),
    );
    expect(review.body).toMatchObject({
      body: expect.stringContaining("### Required Fixes"),
      event: "COMMENT",
    });
    expect(review.body.comments).toBeUndefined();
  });

  it("rejects malformed inline comment anchors before creating a pull request review", async () => {
    const cases = /** @type {Array<[unknown, string]>} */ ([
      ["not-array", "review-matrix inline_comments must be an array."],
      [[null], "review-matrix inline_comments[0] must be an object."],
      [[{ body: "Missing path.", line: 4 }], "must define path, line, and body"],
      [
        [{ body: "Invalid finding ID.", finding_id: "invalid id", line: 4, path: "src/app.ts" }],
        "finding_id must match the allowed pattern",
      ],
      [
        [
          { body: "Explicit duplicate.", finding_id: "review-1", line: 4, path: "src/app.ts" },
          {
            body: "<!-- git-vibe:review-finding id=review-1 -->\nMarker duplicate.",
            line: 5,
            path: "src/app.ts",
          },
        ],
        "finding_id must be unique: review-1",
      ],
    ]);

    for (const [inlineComments, message] of cases) {
      const client = createClient();
      await expect(
        publishStageResultComment({
          client,
          context: context("pull-request"),
          logger: createLogger(),
          parsedOutput: {
            ...output(),
            findings: ["Malformed inline comment."],
            inline_comments: inlineComments,
            next_state: "changes-required",
            stage: "review-matrix",
          },
          runner: runner({ stage: "review-matrix" }),
        }),
      ).rejects.toThrow(message);
      expect(requestCalls(client).map((request) => request.path)).not.toContain(
        "/repos/example/repo/pulls/12/reviews",
      );
      expect(requestCalls(client).map((request) => request.path)).not.toContain(
        "/repos/example/repo/issues/12/comments",
      );
    }
  });
});

/**
 * @param {ContextPacket["artifact"]["type"]} type
 * @param {Partial<ContextPacket> & { pullRequestHead?: ContextPacket["artifact"]["pullRequestHead"] }} [overrides]
 * @returns {ContextPacket}
 */
function context(type, overrides = {}) {
  return {
    artifact: {
      body: "Body",
      number: "12",
      pullRequestHead: overrides.pullRequestHead,
      title: "Title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: overrides.timeline || [],
  };
}

function output() {
  return {
    assumptions: [],
    comment_body: "Result body.",
    findings: [],
    next_state: "ready-for-materialization",
    references: [],
    stage: "materialize",
    status: "completed",
    summary: "Result summary.",
  };
}

function previousReview(overrides = {}) {
  return {
    author: "git-vibe",
    body: "",
    createdAt: "2026-01-01T00:00:00Z",
    databaseId: 99,
    id: "review-node",
    kind: "pull-request-review",
    url: "https://github.com/example/repo/pull/12#pullrequestreview-99",
    ...overrides,
  };
}

function contextWithPreviousReview(overrides = {}) {
  return {
    ...context("pull-request"),
    timeline: [
      previousReview({
        body: previousReviewBody(),
        ...overrides,
      }),
    ],
  };
}

/**
 * @param {string[]} [extraLines]
 * @param {{ includeRunAttribute?: boolean }} [options]
 * @returns {string}
 */
function previousReviewBody(extraLines = [], options = {}) {
  const runAttribute = options.includeRunAttribute === false ? "" : " run=99";
  return [
    `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12${runAttribute} -->`,
    "## GitVibe Review Matrix",
    "",
    "**Status:** `blocked`",
    "**Next state:** `blocked`",
    "",
    "Previous attempt blocked.",
    ...extraLines.flatMap((line) => ["", line]),
    "",
    "### Result",
    "Workflow run: https://github.com/example/repo/actions/runs/99",
  ].join("\n");
}

/**
 * @param {Partial<RunnerOptions>} [overrides]
 * @returns {RunnerOptions}
 */
function runner(overrides = {}) {
  return {
    cwd: "/repo",
    dryRun: false,
    issueNumber: "12",
    maxTurns: 2,
    prNumber: "12",
    repository: "example/repo",
    stage: "materialize",
    stageTimeoutMinutes: 1,
    token: "token",
    ...overrides,
  };
}

/**
 * @param {{ files?: unknown[]; login?: string; unresolvedReviewLineError?: boolean; userLookupError?: boolean }} [options]
 * @returns {MockGitHubClient}
 */
function createClient(options = {}) {
  let rejectedInlineReview = false;
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async (request) => {
      if (request.path.startsWith("/repos/example/repo/pulls/12/files")) {
        return (
          options.files || [
            {
              filename: "src/app.ts",
              patch:
                "@@ -40,12 +40,12 @@\n line 40\n line 41\n line 42\n line 43\n line 44\n line 45\n line 46\n line 47\n line 48\n line 49\n line 50\n line 51",
            },
          ]
        );
      }
      if (
        options.unresolvedReviewLineError &&
        !rejectedInlineReview &&
        request.method === "POST" &&
        request.path.endsWith("/pulls/12/reviews") &&
        request.body?.comments
      ) {
        rejectedInlineReview = true;
        throw new Error(
          'GitHub API POST /repos/example/repo/pulls/12/reviews failed: 422 {"message":"Unprocessable Entity","errors":["Line could not be resolved"],"status":"422"}',
        );
      }
      if (request.path !== "/user") return {};
      if (options.userLookupError) throw new Error("Resource not accessible by integration");
      return { login: options.login || "git-vibe" };
    }),
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
 * @returns {any[]}
 */
function requestCalls(client) {
  return client.request.mock.calls.map(
    /**
     * @param {any[]} call
     */
    (call) => call[0],
  );
}
