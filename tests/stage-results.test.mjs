// @ts-nocheck
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageRunResult } from "../src/runner/stage-results.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("stageRunResult", () => {
  it("persists validated results under RUNNER_TEMP when available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-stage-result-"));
    process.env.RUNNER_TEMP = directory;

    try {
      const result = await runValidateStageResult("/repo");

      expect(result).toMatchObject({
        schemaId: "validate.v1",
        status: "completed",
        summary: "Validated.",
      });
      expect(result.resultFile).toBe(join(directory, "git-vibe-validate-result.json"));
      expect(existsSync(result.resultFile)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists validated results under cwd when RUNNER_TEMP is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-stage-result-"));
    delete process.env.RUNNER_TEMP;

    try {
      const result = await runValidateStageResult(directory);

      expect(result.resultFile).toBe(join(directory, "git-vibe-validate-result.json"));
      expect(existsSync(result.resultFile)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists stable unique IDs for duplicate review finding anchors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "git-vibe-stage-result-"));
    process.env.RUNNER_TEMP = directory;
    const logger = { event: vi.fn() };
    const inlineComments = [
      reviewComment("src/z.ts", 9, "lease-placement-race"),
      reviewComment("src/a.ts", 4, "lease-placement-race"),
      reviewComment("src/unique.ts", 7, "unique-finding"),
    ];

    try {
      const first = await runReviewStageResult(directory, inlineComments, logger);
      const second = await runReviewStageResult(directory, [...inlineComments].reverse(), logger);
      const firstIds = findingIdsByPath(first.parsedOutput);
      const secondIds = findingIdsByPath(second.parsedOutput);

      expect(firstIds).toEqual(secondIds);
      expect(new Set(Object.values(firstIds))).toHaveProperty("size", 3);
      expect(firstIds["src/a.ts"]).toBe("lease-placement-race");
      expect(firstIds["src/z.ts"]).toMatch(/^lease-placement-race:[a-f0-9]{16}$/);
      expect(firstIds["src/unique.ts"]).toBe("unique-finding");
      expect(logger.event).toHaveBeenCalledWith("output.inline_comments.normalized", {
        duplicate_finding_ids: 1,
        rewritten_inline_comments: 1,
      });

      const persisted = JSON.parse(readFileSync(second.resultFile, "utf8"));
      expect(findingIdsByPath(persisted.parsedOutput)).toEqual(secondIds);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function runValidateStageResult(cwd) {
  return stageRunResult({
    content: JSON.stringify({
      assumptions: [],
      comment_body: "Ready.",
      findings: [],
      next_state: "ready-for-implementation",
      references: [],
      stage: "validate",
      status: "completed",
      summary: "Validated.",
    }),
    context: {
      artifact: {
        body: "Body",
        number: "12",
        title: "Issue",
        type: "issue",
        url: "https://github.com/example/repo/issues/12",
      },
      generatedAt: "2026-01-01T00:00:00Z",
      repository: "example/repo",
      timeline: [],
    },
    definition: stageDefinitions.validate,
    logger: { event: vi.fn() },
    options: {
      cwd,
      dryRun: false,
      issueNumber: "12",
      maxTurns: 2,
      repository: "example/repo",
      stage: "validate",
      stageTimeoutMinutes: 1,
      token: "token",
    },
  });
}

function runReviewStageResult(cwd, inlineComments, logger) {
  return stageRunResult({
    content: JSON.stringify({
      assumptions: [],
      comment_body: "Required fixes.",
      findings: ["Placement can race with review."],
      inline_comments: inlineComments,
      next_state: "changes-required",
      references: ["src/a.ts", "src/z.ts"],
      stage: "review-matrix",
      status: "completed",
      summary: "Review found a race.",
    }),
    context: {
      artifact: {
        body: "Body",
        number: "12",
        title: "Pull request",
        type: "pull-request",
        url: "https://github.com/example/repo/pull/12",
      },
      generatedAt: "2026-01-01T00:00:00Z",
      repository: "example/repo",
      timeline: [],
    },
    definition: stageDefinitions["review-matrix"],
    logger,
    options: {
      cwd,
      dryRun: false,
      maxTurns: 2,
      prNumber: "12",
      repository: "example/repo",
      stage: "review-matrix",
      stageTimeoutMinutes: 1,
      token: "token",
    },
  });
}

function reviewComment(path, line, findingId) {
  return {
    body: `Fix the race at ${path}:${line}.`,
    finding_id: findingId,
    line,
    path,
    side: "RIGHT",
  };
}

function findingIdsByPath(output) {
  return Object.fromEntries(
    output.inline_comments.map((comment) => [comment.path, comment.finding_id]),
  );
}
