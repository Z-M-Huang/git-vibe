import { describe, expect, it, vi } from "vitest";
import { createPullRequestReview } from "../src/runner/pr-review-github.ts";

describe("pull request review commit binding", () => {
  it("submits the review against the frozen target SHA", async () => {
    const request = vi.fn().mockResolvedValue({});
    const commitId = "a".repeat(40);

    await createPullRequestReview({
      body: "Review body",
      client: /** @type {any} */ ({ request }),
      comments: [],
      commitId,
      pullNumber: "12",
      repository: "example/repo",
      token: "token",
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ commit_id: commitId, event: "COMMENT" }),
        path: "/repos/example/repo/pulls/12/reviews",
      }),
    );
  });
});
