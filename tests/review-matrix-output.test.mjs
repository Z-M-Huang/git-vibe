import { describe, expect, it } from "vitest";
import { normalizeReviewMatrixOutput } from "../src/runner/review-matrix-output.ts";

/** @typedef {import("../src/shared/types.ts").ContextPacket} ContextPacket */
/** @typedef {import("../src/shared/types.ts").JsonObject} JsonObject */
/** @typedef {{ body: string, finding_id: string, line: number, path: string, start_line?: number }} InlineComment */

describe("duplicate review finding IDs", () => {
  it("normalizes duplicate and occupied collision IDs deterministically", () => {
    const duplicates = [
      inlineComment("src/shared.ts", 9, "Later finding.", "duplicate-finding"),
      inlineComment("src/shared.ts", 4, "Earlier finding.", "duplicate-finding"),
    ];
    const baseline = normalizeReviewMatrixOutput({ ...output(), inline_comments: duplicates });
    const occupiedCollisionId = findingIdsByAnchor(baseline.output)[anchorKey(duplicates[0])][0];
    const comments = [
      ...duplicates,
      inlineComment("src/occupied.ts", 7, "Separate finding.", occupiedCollisionId),
    ];

    const first = normalizeReviewMatrixOutput({ ...output(), inline_comments: comments });
    const second = normalizeReviewMatrixOutput({
      ...output(),
      inline_comments: [...comments].reverse(),
    });
    const firstIds = findingIdsByAnchor(first.output);
    const allFirstIds = Object.values(firstIds).flat();

    expect(first.duplicateFindingIds).toBe(1);
    expect(first.rewrittenInlineComments).toBe(1);
    expect(allFirstIds).toHaveLength(3);
    expect(new Set(allFirstIds)).toHaveProperty("size", 3);
    expect(firstIds[anchorKey(duplicates[1])]).toEqual(["duplicate-finding"]);
    expect(firstIds[anchorKey(duplicates[0])]).not.toContain(occupiedCollisionId);
    expect(findingIdsByAnchor(second.output)).toEqual(firstIds);
  });

  it("keeps a prior anchor ID when its duplicate group shrinks", () => {
    const duplicates = [
      inlineComment("src/a.ts", 4, "First issue.", "duplicate-finding"),
      inlineComment("src/z.ts", 9, "Remaining issue.", "duplicate-finding"),
    ];
    const initial = normalizeReviewMatrixOutput({ ...output(), inline_comments: duplicates });
    const initialIds = findingIdsByAnchor(initial.output);
    const reviewContext = contextWithPriorComments(inlineComments(initial.output));

    const normalized = normalizeReviewMatrixOutput(
      {
        ...output(),
        inline_comments: [inlineComment("src/z.ts", 9, "Remaining issue.", "duplicate-finding")],
        next_state: "changes-required",
        resolved_finding_ids: [initialIds[anchorKey(duplicates[0])][0]],
      },
      reviewContext,
    );

    expect(findingIdsByAnchor(normalized.output)[anchorKey(duplicates[1])]).toEqual(
      initialIds[anchorKey(duplicates[1])],
    );
    expect(normalized.duplicateFindingIds).toBe(0);
    expect(normalized.rewrittenInlineComments).toBe(1);
    expect(normalized.output.resolved_finding_ids).toEqual([
      initialIds[anchorKey(duplicates[0])][0],
    ]);
  });
});

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
  it("drops finding IDs that GitHub already considers resolved", () => {
    const reviewContext = {
      ...context(),
      resolvedReviewFindingIds: ["resolved-review"],
      timeline: [],
    };

    const normalized = normalizeReviewMatrixOutput(
      { ...output(), resolved_finding_ids: ["resolved-review"] },
      reviewContext,
    );

    expect(normalized.redundantResolvedFindingIds).toBe(1);
    expect(normalized.output.resolved_finding_ids).toEqual([]);
    expect(normalized.output.next_state).toBe("review-passed");
  });

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

/** @param {string} path @param {number} line @param {string} body @param {string} findingId @returns {InlineComment} */
function inlineComment(path, line, body, findingId) {
  return { body, finding_id: findingId, line, path };
}

/** @param {JsonObject} value @returns {InlineComment[]} */
function inlineComments(value) {
  if (!Array.isArray(value.inline_comments)) throw new Error("Expected inline comments.");
  return value.inline_comments.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Expected an inline comment object.");
    }
    return /** @type {InlineComment} */ (item);
  });
}

/** @param {InlineComment} item @returns {string} */
function anchorKey(item) {
  return JSON.stringify([item.path, item.start_line || null, item.line, item.body]);
}

/** @param {JsonObject} value @returns {Record<string, string[]>} */
function findingIdsByAnchor(value) {
  /** @type {Record<string, string[]>} */
  const findingIds = {};
  for (const item of inlineComments(value)) {
    const key = anchorKey(item);
    findingIds[key] = [...(findingIds[key] || []), item.finding_id].sort();
  }
  return Object.fromEntries(
    Object.entries(findingIds).sort(([left], [right]) =>
      left === right ? 0 : left < right ? -1 : 1,
    ),
  );
}

/** @param {InlineComment[]} comments @returns {ContextPacket} */
function contextWithPriorComments(comments) {
  const value = context();
  value.timeline = comments.map((comment, index) => ({
    author: "gitvibe-for-github[bot]",
    body: `<!-- git-vibe:review-finding id=${comment.finding_id} -->\n${comment.body}`,
    createdAt: `2026-07-31T00:00:0${index}Z`,
    id: `comment-${index}`,
    kind: "pull-request-review-comment",
    line: comment.line,
    path: comment.path,
    url: `https://github.com/example/repo/pull/12#discussion_r${index}`,
  }));
  return value;
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
