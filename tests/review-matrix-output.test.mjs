import { describe, expect, it } from "vitest";
import { normalizeReviewMatrixOutput } from "../src/runner/review-matrix-output.ts";

/** @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket */

describe("incremental review finding obligations", () => {
  it("carries unresolved findings that are outside the incremental patch", () => {
    const normalized = normalizeReviewMatrixOutput(output(), context());

    expect(normalized.carriedFindings).toBe(1);
    expect(normalized.output.next_state).toBe("changes-required");
    expect(normalized.output.findings).toEqual([
      expect.stringContaining("Existing unresolved GitVibe finding review-1"),
    ]);
  });

  it("allows an existing finding to close only when explicitly resolved", () => {
    const normalized = normalizeReviewMatrixOutput(
      { ...output(), resolved_finding_ids: ["review-1"] },
      context(),
    );

    expect(normalized.carriedFindings).toBe(0);
    expect(normalized.output.next_state).toBe("review-passed");
    expect(normalized.output.findings).toEqual([]);
  });
});

describe("incremental review unanchored finding obligations", () => {
  it("tracks unanchored findings from the exact checkpoint review", () => {
    const reviewContext = contextWithCheckpointReview(
      [
        "### Unanchored Inline Findings",
        "1. `src/app.ts:9` (line is not in the pull request diff) <!-- git-vibe:review-finding-unanchored id=review-unanchored -->",
        "   Null values still crash this unchanged path.",
      ].join("\n"),
    );

    const carried = normalizeReviewMatrixOutput(
      { ...output(), resolved_finding_ids: ["review-1"] },
      reviewContext,
    );
    expect(carried.carriedFindings).toBe(1);
    expect(carried.output.findings).toEqual([
      expect.stringContaining("<!-- git-vibe:review-finding-unanchored id=review-unanchored -->"),
    ]);

    const resolved = normalizeReviewMatrixOutput(
      { ...output(), resolved_finding_ids: ["review-1", "review-unanchored"] },
      reviewContext,
    );
    expect(resolved.carriedFindings).toBe(0);
    expect(resolved.output.findings).toEqual([]);
  });

  it("recovers legacy unanchored IDs only when the mapping is unambiguous", () => {
    const reviewContext = contextWithCheckpointReview(
      [
        "### Required Fixes",
        "1. review-1",
        "2. memory-pack-predicate-key-bounds",
        "",
        "### Unanchored Inline Findings",
        "1. `internal/service/memory_pack.go:42` (line is not in the pull request diff)",
        "   Predicate keys need the public contract bound.",
      ].join("\n"),
    );

    const normalized = normalizeReviewMatrixOutput(
      {
        ...output(),
        resolved_finding_ids: ["review-1", "memory-pack-predicate-key-bounds"],
      },
      reviewContext,
    );

    expect(normalized.carriedFindings).toBe(0);
    expect(normalized.output.next_state).toBe("review-passed");
  });

  it("ignores unanchored markers outside the exact checkpoint review", () => {
    const reviewContext = contextWithCheckpointReview(
      "<!-- git-vibe:review-finding-unanchored id=stale-unanchored -->",
    );
    const review = reviewContext.timeline.find((item) => item.kind === "pull-request-review");
    if (!review) throw new Error("Expected checkpoint review.");
    review.createdAt = "2026-07-31T02:00:00Z";

    expect(() =>
      normalizeReviewMatrixOutput(
        { ...output(), resolved_finding_ids: ["stale-unanchored"] },
        reviewContext,
      ),
    ).toThrow("resolved_finding_ids contains unknown finding: stale-unanchored");
  });

  it("rejects ambiguous legacy unanchored ID mappings", () => {
    const reviewContext = contextWithCheckpointReview(
      [
        "### Required Fixes",
        "1. review-1",
        "2. possible-unanchored-1",
        "3. possible-unanchored-2",
        "",
        "### Unanchored Inline Findings",
        "1. `src/app.ts:9` (line is not in the pull request diff)",
        "   One unanchored finding cannot identify two missing IDs.",
      ].join("\n"),
    );

    expect(() =>
      normalizeReviewMatrixOutput(
        { ...output(), resolved_finding_ids: ["possible-unanchored-1"] },
        reviewContext,
      ),
    ).toThrow("resolved_finding_ids contains unknown finding: possible-unanchored-1");
  });
});

describe("incremental review finding ID validation", () => {
  it("rejects unknown or simultaneously current and resolved finding ids", () => {
    expect(() =>
      normalizeReviewMatrixOutput({ ...output(), resolved_finding_ids: ["unknown"] }, context()),
    ).toThrow("resolved_finding_ids contains unknown finding: unknown");
    expect(() =>
      normalizeReviewMatrixOutput(
        {
          ...output(),
          inline_comments: [
            {
              body: "Still broken.",
              finding_id: "review-1",
              line: 3,
              path: "src/app.ts",
            },
          ],
          resolved_finding_ids: ["review-1"],
        },
        context(),
      ),
    ).toThrow("Finding review-1 cannot be current and resolved");
  });
});

function output() {
  return {
    findings: [],
    inline_comments: [],
    next_state: "review-passed",
    status: "completed",
  };
}

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
      baseSha: "a".repeat(40),
      checkpointSha: "b".repeat(40),
      headRepository: "contributor/repo",
      snapshotSha: "c".repeat(64),
      targetSha: "d".repeat(40),
    },
    timeline: [
      {
        author: "gitvibe-for-github[bot]",
        body: "<!-- git-vibe:review-finding id=review-1 -->\nNull values still crash this path.",
        createdAt: "2026-07-31T00:00:00Z",
        id: "comment-1",
        kind: "pull-request-review-comment",
        url: "https://github.com/example/repo/pull/12#discussion_r1",
      },
    ],
  };
}

/**
 * @param {string} details
 * @returns {ContextPacket}
 */
function contextWithCheckpointReview(details) {
  const value = context();
  const submittedAt = "2026-07-31T01:00:00Z";
  if (!value.reviewScope) throw new Error("Expected incremental review scope.");
  value.reviewScope.checkpointSubmittedAt = submittedAt;
  value.timeline.push({
    author: "gitvibe-for-github[bot]",
    body: [
      `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 review-version=1 base-sha=${"a".repeat(40)} head-sha=${"b".repeat(40)} snapshot-sha=${"e".repeat(64)} -->`,
      "**Status:** `completed`",
      details,
    ].join("\n"),
    createdAt: submittedAt,
    id: "review-1",
    kind: "pull-request-review",
    url: "https://github.com/example/repo/pull/12#pullrequestreview-1",
  });
  return value;
}
