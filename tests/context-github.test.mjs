import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureGitVibeLabels,
  isProtectedGitVibeLabel,
  removeIssueLabel,
} from "../src/app/labels.ts";
import { loadConfig, testCommandsFor } from "../src/runner/config.ts";
import { buildDiscussionContext, buildIssueContext } from "../src/runner/context.ts";
import {
  GitHubClient,
  repositoryActionsVariable,
  repositoryDefaultBranch,
  splitRepository,
} from "../src/shared/github.ts";
import { gitVibeLabelList } from "../src/shared/labels.ts";

const originalFetch = globalThis.fetch;

/**
 * @typedef {import("../src/shared/github.ts").GitHubClient & { graphql: any; request: any }} MockGitHubClient
 * @typedef {import("../src/shared/github.ts").GitHubRequest} GitHubRequest
 */

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub context builders", () => {
  it("builds issue context from issue body and sorted comments", async () => {
    const client = pullRequestContextClient();

    const context = await buildPullRequestContext(client);

    expect(context.artifact).toMatchObject({
      labels: ["git-vibe:accept-risk", "custom"],
      number: "4",
      pullRequestHead: { branch: "git-vibe/4", repository: "example/repo" },
      title: "Issue title",
      type: "pull-request",
    });
    expect(context.timeline.map((item) => item.body)).toEqual([
      "Issue body",
      "First",
      "Second",
      "<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=4 -->\n## GitVibe Review Matrix",
      "Path: src/file.ts\nDiff:\n@@ -1 +1 @@\n\nReview feedback",
      "Path: src/old.ts\nOutdated feedback",
    ]);
    expect(context.timeline.at(-2)).toMatchObject({
      databaseId: 9,
      parentId: "8",
      reviewThreadId: "thread-9",
    });
    expect(context.resolvedReviewFindingIds).toEqual(["resolved-review"]);
    expect(context.artifact.updatedAt).toBe("2026-01-06T00:00:00Z");
    expect(context.timeline[0].updatedAt).toBeUndefined();
    expect(context.timeline[1].updatedAt).toBe("2026-01-03T01:00:00Z");
    expect(context.timeline.at(3)).toMatchObject({
      databaseId: 7,
      id: "7",
      kind: "pull-request-review",
      updatedAt: "2026-01-04T12:00:00Z",
    });
    expect(context.pullRequestFiles).toEqual([
      expect.objectContaining({
        filename: "src/file.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
        status: "modified",
      }),
    ]);
  });

  it("keeps pull request changed-file patches available for chunking", async () => {
    const longPatch = `@@ -1 +1 @@\n-${"a".repeat(21_000)}\n+replacement`;
    const client = mockGitHubClient({
      request: vi
        .fn()
        .mockResolvedValueOnce(issueFixture())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(pullRequestFixture())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { filename: "docs/large.md", patch: longPatch, status: "modified" },
        ]),
      graphql: vi.fn().mockResolvedValueOnce(reviewThreadFixtures()),
    });

    const context = await buildIssueContext({
      client,
      issueNumber: "4",
      repository: "example/repo",
      token: "token",
      type: "pull-request",
    });

    expect(context.pullRequestFiles?.[0].patch).toBe(longPatch);
  });

  it("uses stable fallbacks for sparse issue payloads", async () => {
    const client = mockGitHubClient({
      request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce([{}]),
    });

    const context = await buildIssueContext({
      client,
      issueNumber: "6",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({
      body: "",
      number: "6",
      title: "",
      type: "issue",
      url: "",
    });
    expect(context.timeline[0]).toMatchObject({ author: "<unknown>", id: "issue-6" });
  });
});

describe("GitHub pull request feedback context", () => {
  it("adds source issue, discussion, parent issue, and sub-issue context", async () => {
    const client = mockGitHubClient({
      request: vi
        .fn()
        .mockResolvedValueOnce({
          ...issueFixture(),
          body: "## GitVibe Traceability\n\nRefs #15",
        })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(pullRequestFixture())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({
          ...issueFixture(),
          body: "Source issue body\n\n<!-- git-vibe:source-discussion number=9 url=https://github.com/example/repo/discussions/9 -->",
          number: 15,
        })
        .mockResolvedValueOnce([{ body: "Source issue comment", id: 15 }])
        .mockResolvedValueOnce({ ...issueFixture(), body: "Parent issue body", number: 8 })
        .mockResolvedValueOnce([{ body: "Parent issue comment", id: 8 }])
        .mockResolvedValueOnce({ ...issueFixture(), body: "Sub-issue body", number: 16 })
        .mockResolvedValueOnce([{ body: "Sub-issue comment", id: 16 }])
        .mockResolvedValueOnce(pullRequestFileFixtures()),
      graphql: vi
        .fn()
        .mockResolvedValueOnce(reviewThreadFixtures())
        .mockResolvedValueOnce(discussionFixture())
        .mockResolvedValueOnce(relatedIssuesFixture()),
    });

    const context = await buildIssueContext({
      client,
      issueNumber: "4",
      repository: "example/repo",
      token: "token",
      type: "pull-request",
    });

    expect(context.timeline.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "source-issue-body",
        "source-issue-comment",
        "source-discussion-body",
        "source-discussion-comment",
        "parent-issue-body",
        "parent-issue-comment",
        "sub-issue-body",
        "sub-issue-comment",
      ]),
    );
    expect(context.timeline.map((item) => item.body)).toEqual(
      expect.arrayContaining([
        "Source issue comment",
        "Discussion comment",
        "Parent issue comment",
        "Sub-issue comment",
      ]),
    );
  });
});

/** @param {MockGitHubClient} client */
function buildPullRequestContext(client) {
  return buildIssueContext({
    client,
    issueNumber: "4",
    repository: "example/repo",
    token: "token",
    type: "pull-request",
  });
}

function pullRequestContextClient() {
  return mockGitHubClient({
    request: vi
      .fn()
      .mockResolvedValueOnce(issueFixture())
      .mockResolvedValueOnce(commentFixtures())
      .mockResolvedValueOnce(pullRequestFixture())
      .mockResolvedValueOnce(reviewFixtures())
      .mockResolvedValueOnce(pullRequestFileFixtures()),
    graphql: vi.fn().mockResolvedValueOnce(reviewThreadFixtures()),
  });
}

function pullRequestFixture() {
  return {
    head: {
      ref: "git-vibe/4",
      repo: { full_name: "example/repo" },
    },
  };
}

function pullRequestFileFixtures() {
  return [
    {
      additions: 1,
      blob_url: "https://github.com/example/repo/blob/git-vibe/4/src/file.ts",
      changes: 2,
      deletions: 1,
      filename: "src/file.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      raw_url: "https://github.com/example/repo/raw/git-vibe/4/src/file.ts",
      status: "modified",
    },
  ];
}

function issueFixture() {
  return {
    body: "Issue body",
    created_at: "2026-01-02T00:00:00Z",
    html_url: "https://github.com/example/repo/issues/4",
    labels: [{ name: "git-vibe:accept-risk" }, "custom"],
    number: 4,
    title: "Issue title",
    updated_at: "2026-01-06T00:00:00Z",
    user: { login: "author" },
  };
}

function commentFixtures() {
  return [
    {
      body: "Second",
      created_at: "2026-01-04T00:00:00Z",
      html_url: "comment-2",
      id: 2,
      updated_at: "2026-01-04T01:00:00Z",
      user: { login: "b" },
    },
    {
      body: "First",
      created_at: "2026-01-03T00:00:00Z",
      html_url: "comment-1",
      id: 1,
      updated_at: "2026-01-03T01:00:00Z",
      user: { login: "a" },
    },
  ];
}

function reviewFixtures() {
  return [
    {
      author_association: "MEMBER",
      body: [
        "<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=4 -->",
        "## GitVibe Review Matrix",
      ].join("\n"),
      html_url: "review-url",
      id: 7,
      submitted_at: "2026-01-04T12:00:00Z",
      user: { login: "git-vibe" },
    },
    {
      body: "",
      id: 8,
      submitted_at: "2026-01-04T13:00:00Z",
    },
  ];
}

function reviewThreadFixtures() {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            reviewThreadFixture(),
            resolvedReviewThreadFixture(),
            outdatedReviewThreadFixture(),
          ],
        },
      },
    },
  };
}

function discussionFixture() {
  return {
    repository: {
      discussion: {
        author: { login: "author" },
        body: "Discussion body",
        comments: {
          nodes: [
            {
              author: { login: "maintainer" },
              body: "Discussion comment",
              createdAt: "2026-01-06T00:00:00Z",
              id: "discussion-comment",
              replies: { nodes: [] },
              url: "discussion-comment-url",
            },
          ],
        },
        createdAt: "2026-01-05T00:00:00Z",
        id: "discussion-id",
        title: "Discussion title",
        url: "discussion-url",
      },
    },
  };
}

function relatedIssuesFixture() {
  return {
    repository: {
      issue: {
        parent: { number: 8 },
        subIssues: { nodes: [{ number: 16 }] },
      },
    },
  };
}

function reviewThreadFixture() {
  return {
    comments: {
      nodes: [
        {
          author: { login: "reviewer" },
          authorAssociation: "COLLABORATOR",
          body: "Review feedback",
          createdAt: "2026-01-05T00:00:00Z",
          databaseId: 9,
          diffHunk: "@@ -1 +1 @@",
          id: "9",
          replyTo: { id: "8" },
          updatedAt: "2026-01-05T01:00:00Z",
          url: "review-comment",
        },
      ],
    },
    id: "thread-9",
    isOutdated: false,
    isResolved: false,
    path: "src/file.ts",
  };
}

function resolvedReviewThreadFixture() {
  return filteredReviewThreadFixture({
    author: "gitvibe-for-github",
    body: "<!-- git-vibe:review-finding id=resolved-review -->\nResolved feedback",
    createdAt: "2026-01-06T00:00:00Z",
    id: "10",
    isResolved: true,
    url: "resolved-review-comment",
  });
}

function outdatedReviewThreadFixture() {
  return filteredReviewThreadFixture({
    body: "Outdated feedback",
    createdAt: "2026-01-07T00:00:00Z",
    id: "11",
    isOutdated: true,
    url: "outdated-review-comment",
  });
}

/**
 * @param {{
 *   author?: string;
 *   body: string;
 *   createdAt: string;
 *   id: string;
 *   isOutdated?: boolean;
 *   isResolved?: boolean;
 *   url: string;
 * }} options
 */
function filteredReviewThreadFixture(options) {
  return {
    comments: {
      nodes: [
        {
          author: { login: options.author || "reviewer" },
          body: options.body,
          createdAt: options.createdAt,
          databaseId: Number(options.id),
          id: options.id,
          url: options.url,
        },
      ],
    },
    id: `thread-${options.id}`,
    isOutdated: options.isOutdated || false,
    isResolved: options.isResolved || false,
    path: "src/old.ts",
  };
}

describe("GitHub discussion context builders", () => {
  it("builds discussion context with labels, replies, and parent ids", async () => {
    const client = mockGitHubClient({
      graphql: vi.fn().mockResolvedValueOnce({
        repository: {
          discussion: {
            author: { login: "author" },
            body: "Discussion body",
            comments: {
              nodes: [
                {
                  author: { login: "commenter" },
                  body: "Comment",
                  createdAt: "2026-01-03T00:00:00Z",
                  id: "comment-id",
                  replies: {
                    nodes: [
                      {
                        author: { login: "reply" },
                        body: "Reply",
                        createdAt: "2026-01-04T00:00:00Z",
                        id: "reply-id",
                        url: "reply-url",
                      },
                    ],
                  },
                  url: "comment-url",
                },
              ],
            },
            createdAt: "2026-01-02T00:00:00Z",
            id: "discussion-id",
            labels: { nodes: [{ name: "git-vibe:approved" }] },
            title: "Discussion title",
            url: "discussion-url",
          },
        },
      }),
    });

    const context = await buildDiscussionContext({
      client,
      discussionNumber: "5",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({ id: "discussion-id", type: "discussion" });
    expect(context.artifact.labels).toEqual(["git-vibe:approved"]);
    expect(context.timeline.map((item) => [item.kind, item.id, item.parentId])).toEqual([
      ["body", "discussion-5", undefined],
      ["comment", "comment-id", undefined],
      ["reply", "reply-id", "comment-id"],
    ]);
  });

  it("uses stable fallbacks for sparse discussion payloads", async () => {
    const client = mockGitHubClient({
      graphql: vi.fn().mockResolvedValueOnce({
        repository: {
          discussion: {
            comments: {
              nodes: [{ id: "comment-id" }],
            },
            id: "discussion-id",
          },
        },
      }),
    });

    const context = await buildDiscussionContext({
      client,
      discussionNumber: "8",
      repository: "example/repo",
      token: "token",
    });

    expect(context.artifact).toMatchObject({ body: "", title: "", url: "" });
    expect(context.timeline.map((item) => item.author)).toEqual(["<unknown>", "<unknown>"]);
  });
});

describe("GitHub client", () => {
  it("requests REST and GraphQL responses", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(204, ""))
      .mockResolvedValueOnce(response(200, { data: { value: 3 } }));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      client.request({ method: "GET", path: "/repos/a/b", token: "t" }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.request({ method: "DELETE", path: "/resource", token: "t" }),
    ).resolves.toEqual({});
    await expect(client.graphql("query", { n: 1 }, "t")).resolves.toEqual({ value: 3 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test/repos/a/b",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer t" }),
      }),
    );
  });
  it("throws clear REST, GraphQL, and repository parsing errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(500, { message: "boom" }, false))
      .mockResolvedValueOnce(response(200, { errors: [{ message: "bad query" }] }));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(client.request({ method: "GET", path: "/bad", token: "t" })).rejects.toThrow(
      "GitHub API GET /bad failed",
    );
    await expect(client.graphql("query", {}, "t")).rejects.toThrow("GitHub GraphQL failed");
    expect(splitRepository("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(() => splitRepository("missing")).toThrow("repository must be owner/repo");

    /** @type {ReturnType<typeof vi.fn>} */ (globalThis.fetch).mockResolvedValueOnce(
      response(200, {}),
    );
    await expect(
      repositoryDefaultBranch({ client, owner: "owner", repo: "repo", token: "t" }),
    ).rejects.toThrow("did not return default_branch");
  });

  it("reads repository Actions variables and treats missing values as unset", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, { value: "  develop " }))
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(404, { message: "missing" }, false));
    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    const options = {
      client,
      name: "GITVIBE_BASE_BRANCH",
      owner: "owner",
      repo: "repo",
      token: "t",
    };

    await expect(repositoryActionsVariable(options)).resolves.toBe("develop");
    await expect(repositoryActionsVariable(options)).resolves.toBeUndefined();
    await expect(repositoryActionsVariable(options)).resolves.toBeUndefined();
  });

  it("retries transient safe GitHub reads but not writes", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false))
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false))
      .mockResolvedValueOnce(response(200, { data: { value: 4 } }))
      .mockResolvedValueOnce(response(504, { message: "timeout" }, false));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      client.request({ method: "GET", path: "/repos/a/b", token: "t" }),
    ).resolves.toEqual({ ok: true });
    await expect(client.graphql("query Test { viewer { login } }", {}, "t")).resolves.toEqual({
      value: 4,
    });
    await expect(client.graphql("mutation Test { noop }", {}, "t")).rejects.toThrow(
      "GitHub API POST /graphql failed: 504",
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });
});

describe("GitHub client transport errors", () => {
  it("includes endpoint and network cause when fetch fails before an HTTP response", async () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const failure = Object.assign(new TypeError("fetch failed"), { cause });
    globalThis.fetch = vi.fn().mockRejectedValueOnce(failure);

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      client.request({
        method: "GET",
        path: "/repos/a/b/issues/33/comments?per_page=100",
        token: "secret-token",
      }),
    ).rejects.toThrow(
      'GitHub API GET /repos/a/b/issues/33/comments?per_page=100 transport failed on attempt 1: name="TypeError" message="fetch failed" cause_name="Error" cause_message="socket hang up" cause_code="ECONNRESET"',
    );
  });
});

describe("GitVibe config and labels", () => {
  it("loads fixed-path config and filters blank test commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "git-vibe-config-"));
    mkdirSync(join(cwd, ".github"));
    writeFileSync(
      join(cwd, ".github", "git-vibe.yml"),
      "tests:\n  commands:\n    - pnpm test\n    - '  '\n",
    );

    const config = loadConfig(cwd);
    expect(testCommandsFor(config)).toEqual(["pnpm test"]);
    expect(loadConfig(join(cwd, "missing"))).toEqual({});

    const emptyCwd = await mkdtemp(join(tmpdir(), "git-vibe-config-empty-"));
    mkdirSync(join(emptyCwd, ".github"));
    writeFileSync(join(emptyCwd, ".github", "git-vibe.yml"), "");
    expect(loadConfig(emptyCwd)).toEqual({});
    expect(testCommandsFor({})).toEqual([]);
  });

  it("creates missing labels, ignores existing labels, and removes labels with encoded names", async () => {
    /** @type {GitHubRequest[]} */
    const requests = [];
    const client = mockGitHubClient({
      request: vi.fn(
        /**
         * @param {GitHubRequest} request
         * @returns {Promise<Record<string, unknown>>}
         */
        async (request) => {
          requests.push(request);
          const body = /** @type {{ name?: string } | undefined} */ (request.body);
          if (body?.name === gitVibeLabelList[0].name) throw new Error("422 already exists");
          return {};
        },
      ),
    });

    await ensureGitVibeLabels({ client, owner: "example", repo: "repo", token: "token" });
    await removeIssueLabel({
      client,
      issueNumber: "3",
      label: "git-vibe:approved",
      owner: "example",
      repo: "repo",
      token: "token",
    });

    expect(requests.filter((request) => request.method === "POST")).toHaveLength(
      gitVibeLabelList.length,
    );
    expect(requests.at(-1)?.path).toBe("/repos/example/repo/issues/3/labels/git-vibe%3Aapproved");
    expect(isProtectedGitVibeLabel("git-vibe:anything")).toBe(true);
    expect(isProtectedGitVibeLabel("gvi:manual")).toBe(true);
  });

  it("rethrows unexpected label creation failures", async () => {
    const client = mockGitHubClient({
      request: vi.fn(async () => {
        throw new Error("500 unavailable");
      }),
    });

    await expect(
      ensureGitVibeLabels({ client, owner: "example", repo: "repo", token: "token" }),
    ).rejects.toThrow("500 unavailable");
  });
});

/** @param {number} status @param {unknown} value @param {boolean} [ok] */
function response(status, value, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    text: async () => (typeof value === "string" ? value : JSON.stringify(value)),
  };
}
function mockGitHubClient(overrides = {}) {
  return /** @type {MockGitHubClient} */ ({
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async () => ({})),
    retryBaseDelayMs: 0,
    ...overrides,
  });
}
