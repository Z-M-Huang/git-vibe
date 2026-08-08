import { describe, expect, it } from "vitest";
import {
  renderStageResultComment,
  renderStageStartComment,
} from "../src/runner/result-comments.ts";

describe("stage result comments", () => {
  it("renders every stage result as compact action-focused Markdown", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      links: [{ label: "Review run", url: "https://github.com/example/repo/actions/runs/22" }],
      parsedOutput: {
        assumptions: ["Existing API remains stable"],
        comment_body: "Detailed notes for reviewers.",
        findings: ["The request is implementable"],
        implementation_plan: ["src/app/server.ts: add command routing test coverage"],
        issue_body: "Create the implementation tracking issue.",
        issue_title: "Implement GitVibe command routing",
        missing_capabilities: ["Threaded PR review replies are not implemented"],
        next_state: "ready-for-implementation",
        partial_capabilities: ["Issue comments are flat replies with source links"],
        proposed_labels: ["gvi:ready-for-approval"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "validate",
        status: "completed",
        summary: "Validation finished.",
        tests: ["corepack pnpm test"],
        working_capabilities: ["Discussion comments can be posted"],
      },
      stage: "validate",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-result stage=validate artifact=issue number=12 run=99 -->",
    );
    expect(body).toContain("## GitVibe Validation");
    expect(body).toContain("**Status:** `completed`");
    expect(body).toContain("**Next state:** `ready-for-implementation`");
    expect(body).toContain("Validation finished.");
    expect(body).toContain("### Next Action\nContinue with `ready-for-implementation`.");
    expect(body).toContain("Full details are in the workflow run summary.");
    expect(body).toContain("Review run: https://github.com/example/repo/actions/runs/22");
    expect(body).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");
    expect(body).not.toContain("### Details");
    expect(body).not.toContain("### Findings");
    expect(body).not.toContain("### Pull Request");
    expect(body).not.toContain("Detailed notes for reviewers.");
    expect(body).not.toContain("Threaded PR review replies are not implemented");
  });

  it("renders ordered questions with up to four options", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        blocking_questions: [
          {
            options: [
              "Use .github/git-vibe.yml",
              "Use package scripts",
              "Use AGENTS.md",
              "Use workflow defaults",
              "Use a new config file",
            ],
            question: "Which source should define required validation commands?",
          },
        ],
        next_state: "needs-info",
        questions: ["Confirm whether the compact comment copy is acceptable."],
        status: "blocked",
        summary: "Investigation needs maintainer input.",
      },
      stage: "investigate",
    });

    expect(body).toContain("### Questions");
    expect(body).toContain(
      "1. [Blocking] Which source should define required validation commands?",
    );
    expect(body).toContain("   A. Use .github/git-vibe.yml");
    expect(body).toContain("   B. Use package scripts");
    expect(body).toContain("   C. Use AGENTS.md");
    expect(body).toContain("   D. Use workflow defaults");
    expect(body).toContain("2. Confirm whether the compact comment copy is acceptable.");
    expect(body).not.toContain("Use a new config file");
    expect(body).toContain(
      "### Next Action\nReply in one comment with question numbers and option letters, or write your own answer for any question.",
    );
    expect(body).not.toContain("### Blocking Questions");
  });
});

describe("stage result comment fallbacks", () => {
  it("handles missing summary, status, and invalid question entries", () => {
    const body = renderStageResultComment({
      context: context("discussion"),
      links: [{ label: "Empty link", url: "" }],
      parsedOutput: {
        next_state: 42,
        questions: [
          "",
          null,
          { options: ["Ignored"], question: "" },
          { options: "not an array", question: "Which fallback should be shown?" },
        ],
        status: 123,
        summary: 123,
      },
      stage: "materialize",
    });

    expect(body).toContain("**Status:** `completed`");
    expect(body).not.toContain("**Next state:**");
    expect(body).toContain("No summary provided.");
    expect(body).toContain("1. Which fallback should be shown?");
    expect(body).not.toContain("Options:");
    expect(body).not.toContain("A. Provide additional context");
    expect(body).not.toContain("Ignored");
    expect(body).not.toContain("Empty link:");
  });
});

describe("pull request feedback result comments", () => {
  it("keeps pull request feedback investigation comments compact", () => {
    const body = renderStageResultComment({
      context: context("pull-request"),
      parsedOutput: {
        feedback_items: [
          {
            id: "review-comment-1",
            status: "answered",
            summary: "Resolved the null handling feedback.",
          },
        ],
        next_state: "fixes-required",
        references: ["https://github.com/example/repo/pull/12#discussion_r1"],
        skipped_feedback: ["Outdated thread was ignored"],
        status: "completed",
        summary: "Open PR feedback requires code changes.",
      },
      stage: "investigate",
    });

    expect(body).toContain("## GitVibe PR Feedback Investigation");
    expect(body).toContain("Open PR feedback requires code changes.");
    expect(body).toContain("### Next Action\nContinue with `fixes-required`.");
    expect(body).toContain("Full details are in the workflow run summary.");
    expect(body).not.toContain("### Feedback Items");
    expect(body).not.toContain("review-comment-1");
    expect(body).not.toContain("### Skipped Feedback");
  });
});

describe("review checkpoint result comments", () => {
  it("binds completed review results to the reviewed SHA range", () => {
    const reviewContext = {
      ...context("pull-request"),
      reviewScope: {
        baseSha: "a".repeat(40),
        checkpointSha: "b".repeat(40),
        headRepository: "contributor/repo",
        snapshotSha: "c".repeat(64),
        targetSha: "d".repeat(40),
      },
    };
    const body = renderStageResultComment({
      context: reviewContext,
      parsedOutput: { next_state: "review-passed", status: "completed", summary: "Passed." },
      stage: "review-matrix",
    });

    expect(body).toContain(
      `review-version=1 base-sha=${reviewContext.reviewScope.baseSha} head-sha=${reviewContext.reviewScope.targetSha} snapshot-sha=${reviewContext.reviewScope.snapshotSha}`,
    );
    expect(body).not.toContain("review-mode");
  });
});

describe("stage start comments", () => {
  it("renders start markers and optional workflow links", () => {
    const body = renderStageStartComment({
      context: context("pull-request"),
      stage: "review-matrix",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain(
      "<!-- git-vibe:stage-start artifact=pull-request number=12 run=99 stage=review-matrix -->",
    );
    expect(body).toContain("Workflow run: https://github.com/example/repo/actions/runs/99");

    expect(renderStageStartComment({ context: context("issue"), stage: "validate" })).not.toContain(
      "Workflow run:",
    );
  });
});

describe("compact stage result comments", () => {
  it("keeps validation details in the artifact instead of the comment", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        comment_body:
          "Validation notes:\n- Runtime labels are internal state\n- Trigger labels stay public",
        findings: ["The request is implementable"],
        missing_capabilities: ["Threaded PR review replies are not implemented"],
        next_state: "ready-for-implementation",
        partial_capabilities: ["Issue comments are flat replies with source links"],
        references: ["https://github.com/example/repo/issues/12"],
        stage: "validate",
        status: "completed",
        summary: "Validation finished.",
        working_capabilities: ["Discussion comments can be posted"],
      },
      stage: "validate",
      workflowRunUrl: "https://github.com/example/repo/actions/runs/99",
    });

    expect(body).toContain("## GitVibe Validation");
    expect(body).toContain("Validation finished.");
    expect(body).toContain("Full details are in the workflow run summary.");
    expect(body).not.toContain("### Capability Status");
    expect(body).not.toContain("### Key Findings");
    expect(body).not.toContain("### Details");
    expect(body).not.toContain("Runtime labels are internal state");
  });

  it("does not render truncated list summaries in comments", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        findings: ["one", "two", "three", "four", "five", "six"],
        next_state: "ready-for-implementation",
        status: "completed",
        summary: "Investigation is ready.",
      },
      stage: "investigate",
    });

    expect(body).toContain("### Next Action\nContinue with `ready-for-implementation`.");
    expect(body).not.toContain("more in the stage result artifact");
    expect(body).not.toContain("### Key Findings");
  });
});

describe("optional result comment sections", () => {
  it("omits next action when the next state is blocked and there are no questions", () => {
    const body = renderStageResultComment({
      context: context("issue"),
      parsedOutput: {
        next_state: "blocked",
        status: "completed",
        summary: "Investigation is blocked.",
      },
      stage: "investigate",
    });

    expect(body).not.toContain("### Next Action");
  });
});

/**
 * @param {import("../src/shared/types.ts").ContextPacket["artifact"]["type"]} type
 * @returns {import("../src/shared/types.ts").ContextPacket}
 */
function context(type) {
  return {
    artifact: {
      body: "Issue body",
      number: "12",
      title: "Issue title",
      type,
      url: `https://github.com/example/repo/${type}s/12`,
    },
    generatedAt: "2026-01-01T00:00:00Z",
    repository: "example/repo",
    timeline: [],
  };
}
