// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { discussionContext, pullRequestReviewContext } from "../src/runner/context-graphql.ts";
import { GitHubClient, paginatedGitHubRequest } from "../src/shared/github.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub pagination helpers", () => {
  it("paginates REST list responses", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, firstPage))
      .mockResolvedValueOnce(response(200, [{ id: 100 }]));

    const client = new GitHubClient({ apiBaseUrl: "https://api.test", retryBaseDelayMs: 0 });
    await expect(
      paginatedGitHubRequest(client, {
        method: "GET",
        path: "/repos/a/b/issues/1/comments?direction=asc",
        token: "t",
      }),
    ).resolves.toHaveLength(101);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.test/repos/a/b/issues/1/comments?direction=asc&page=1&per_page=100",
      expect.any(Object),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.test/repos/a/b/issues/1/comments?direction=asc&page=2&per_page=100",
      expect.any(Object),
    );
  });
});

describe("pull request review thread pagination", () => {
  it("paginates review threads while separating resolved GitVibe finding IDs", async () => {
    const client = mockGitHubClient({ graphql: reviewThreadGraphql() });

    await expect(
      pullRequestReviewContext({
        client,
        name: "repo",
        owner: "example",
        pullNumber: "4",
        token: "token",
      }),
    ).resolves.toMatchObject({
      comments: [
        {
          body: "First",
          databaseId: 1,
          id: "comment-1",
          path: "src/a.ts",
          reviewThreadId: "thread-1",
          reviewThreadIsOutdated: true,
        },
        {
          body: "Second",
          databaseId: 2,
          id: "comment-2",
          path: "src/b.ts",
          reviewThreadId: "thread-1",
          reviewThreadIsOutdated: true,
        },
        {
          body: "Third",
          databaseId: 3,
          id: "comment-3",
          path: "src/c.ts",
          reviewThreadId: "thread-2",
          reviewThreadIsOutdated: false,
        },
      ],
      resolvedFindingIds: ["resolved-review"],
    });
  });
});

function reviewThreadGraphql() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                comments: {
                  nodes: [{ body: "First", databaseId: 1, id: "comment-1" }],
                  pageInfo: { hasNextPage: true, endCursor: "comment-cursor" },
                },
                id: "thread-1",
                isOutdated: true,
                isResolved: false,
                path: "src/a.ts",
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "thread-cursor" },
          },
        },
      },
    })
    .mockResolvedValueOnce({
      node: {
        comments: {
          nodes: [{ body: "Second", databaseId: 2, id: "comment-2", path: "src/b.ts" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })
    .mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                comments: { nodes: [{ body: "Third", databaseId: 3, id: "comment-3" }] },
                id: "thread-2",
                isOutdated: false,
                isResolved: false,
                path: "src/c.ts",
              },
              {
                comments: {
                  nodes: [
                    {
                      author: { login: "gitvibe-for-github[bot]" },
                      body: "<!-- git-vibe:review-finding id=resolved-review -->\nFixed.",
                      databaseId: 4,
                      id: "comment-4",
                    },
                    {
                      author: { login: "reviewer" },
                      body: "<!-- git-vibe:review-finding id=spoofed-review -->",
                      databaseId: 5,
                      id: "comment-5",
                    },
                  ],
                },
                id: "thread-3",
                isOutdated: false,
                isResolved: true,
                path: "src/d.ts",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
}

describe("discussion context pagination", () => {
  it("paginates discussion labels, comments, and replies for runner context", async () => {
    const client = mockGitHubClient({
      graphql: vi
        .fn()
        .mockResolvedValueOnce({
          repository: {
            discussion: {
              author: { login: "author" },
              body: "Body",
              comments: {
                nodes: [
                  {
                    body: "Comment 1",
                    id: "comment-1",
                    replies: {
                      nodes: [{ body: "Reply 1", id: "reply-1" }],
                      pageInfo: { hasNextPage: true, endCursor: "reply-cursor" },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "comment-cursor" },
              },
              id: "discussion-id",
              labels: {
                nodes: [{ name: "first" }],
                pageInfo: { hasNextPage: true, endCursor: "label-cursor" },
              },
              title: "Title",
            },
          },
        })
        .mockResolvedValueOnce({
          node: {
            labels: {
              nodes: [{ name: "second" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
        .mockResolvedValueOnce({
          node: {
            replies: {
              nodes: [{ body: "Reply 2", id: "reply-2" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
        .mockResolvedValueOnce({
          node: {
            comments: {
              nodes: [{ body: "Comment 2", id: "comment-2", replies: { nodes: [] } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
    });

    await expect(
      discussionContext({
        client,
        discussionNumber: "7",
        name: "repo",
        owner: "example",
        token: "token",
      }),
    ).resolves.toMatchObject({
      comments: [
        { body: "Comment 1", replies: { nodes: [{ body: "Reply 1" }, { body: "Reply 2" }] } },
        { body: "Comment 2", replies: { nodes: [] } },
      ],
      labels: [{ name: "first" }, { name: "second" }],
    });
  });
});

function response(status, value, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(value),
  };
}

function mockGitHubClient(overrides = {}) {
  return {
    apiBaseUrl: "https://api.github.test",
    graphql: vi.fn(async () => ({})),
    request: vi.fn(async () => ({})),
    retryBaseDelayMs: 0,
    ...overrides,
  };
}
