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
