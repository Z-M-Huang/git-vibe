import { describe, expect, it } from "vitest";
import {
  acceptedRiskArtifactContentSha,
  acceptedRiskMetadataBlock,
  acceptedRiskStageResultBody,
  appendAcceptedRiskMetadataBlock,
  parseAcceptedRiskMetadata,
} from "../src/shared/accepted-risk.ts";
import { parseStageResultMarker, stageResultStatus } from "../src/shared/stage-result-markers.ts";

describe("stage result markers", () => {
  it("parses valid markers and normalizes result status", () => {
    const body = [
      "<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 run=99 -->",
      "**Status:** `READY_FOR_REVIEW`",
    ].join("\n");

    expect(parseStageResultMarker(body)).toEqual({
      artifact: "pull-request",
      number: "12",
      run: "99",
      stage: "review-matrix",
    });
    expect(stageResultStatus(body)).toBe("ready-for-review");
  });

  it("ignores malformed markers and missing status lines", () => {
    expect(parseStageResultMarker("")).toBeUndefined();
    expect(parseStageResultMarker("<!-- git-vibe:stage-result -->")).toBeUndefined();
    expect(
      parseStageResultMarker(
        "<!-- git-vibe:stage-result stage=missing artifact=issue number=12 -->",
      ),
    ).toBeUndefined();
    expect(
      parseStageResultMarker(
        "<!-- git-vibe:stage-result stage=validate artifact=unknown number=12 -->",
      ),
    ).toBeUndefined();
    expect(parseStageResultMarker("<!-- git-vibe:stage-result stage=validate -->")).toBeUndefined();
    expect(stageResultStatus("**Status:** blocked")).toBe("");
    expect(stageResultStatus("## GitVibe Result")).toBe("");
  });

  it("parses immutable review checkpoint metadata", () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const snapshotSha = "c".repeat(64);
    const body = `<!-- git-vibe:stage-result stage=review-matrix artifact=pull-request number=12 review-version=1 base-sha=${baseSha} head-sha=${headSha} snapshot-sha=${snapshotSha} -->`;

    expect(parseStageResultMarker(body)).toMatchObject({
      artifact: "pull-request",
      baseSha,
      headSha,
      number: "12",
      reviewVersion: "1",
      snapshotSha,
      stage: "review-matrix",
    });
  });
});

describe("accepted-risk metadata markers", () => {
  it("renders, replaces, and parses accepted-risk metadata blocks", () => {
    /** @type {import("../src/shared/accepted-risk.ts").AcceptedRiskMetadata} */
    const metadata = {
      actor: "bad`actor",
      artifact: "pull-request",
      artifactContentSha: "content-sha",
      artifactSha: "head-sha",
      cutoff: "2026-01-04T00:00:00Z",
      number: "12",
      stage: "review-matrix",
      stages: ["review-matrix"],
    };

    const block = acceptedRiskMetadataBlock(metadata);
    expect(block).toContain("### Accepted Risk");
    expect(block).toContain("`bad'actor` accepted this prompt-injection input risk");
    expect(parseAcceptedRiskMetadata(block)).toEqual(metadata);

    const updated = appendAcceptedRiskMetadataBlock(
      appendAcceptedRiskMetadataBlock("Result body", metadata),
      { ...metadata, cutoff: "2026-01-05T00:00:00Z" },
    );

    expect(updated.match(/git-vibe:accepted-risk-metadata/g)).toHaveLength(1);
    expect(parseAcceptedRiskMetadata(updated)).toMatchObject({
      cutoff: "2026-01-05T00:00:00Z",
    });
  });

  it("ignores invalid accepted-risk metadata and falls back to the marker stage", () => {
    expect(acceptedRiskArtifactContentSha({ body: null })).toBe(
      acceptedRiskArtifactContentSha({ body: "", title: "" }),
    );
    expect(parseAcceptedRiskMetadata("")).toBeUndefined();
    expect(
      parseAcceptedRiskMetadata(
        "<!-- git-vibe:accepted-risk-metadata stage=validate artifact=unknown number=12 cutoff=2026-01-04T00%3A00%3A00Z artifact-content-sha=x -->",
      ),
    ).toBeUndefined();
    expect(
      parseAcceptedRiskMetadata(
        "<!-- git-vibe:accepted-risk-metadata stage=missing artifact=issue number=12 cutoff=2026-01-04T00%3A00%3A00Z artifact-content-sha=x -->",
      ),
    ).toBeUndefined();

    expect(
      parseAcceptedRiskMetadata(
        "<!-- git-vibe:accepted-risk-metadata stage=validate artifact=issue number=12 cutoff=2026-01-04T00%3A00%3A00Z artifact-content-sha=x -->",
      ),
    ).toMatchObject({ stage: "validate", stages: ["validate"] });
  });
});

describe("accepted-risk compact stage result bodies", () => {
  it("renders compact accepted-risk stage result bodies", () => {
    /** @type {import("../src/shared/accepted-risk.ts").AcceptedRiskMetadata} */
    const metadata = {
      actor: "maintainer",
      artifact: "pull-request",
      artifactContentSha: "content-sha",
      artifactSha: "head-sha",
      cutoff: "2026-01-04T00:00:00Z",
      number: "12",
      run: "99",
      runAttempt: "2",
      stage: "review-matrix",
      stages: ["review-matrix"],
    };

    const body = acceptedRiskStageResultBody(
      {
        artifact: "pull-request",
        number: "12",
        run: "99",
        stage: "review-matrix",
      },
      metadata,
    );

    expect(parseStageResultMarker(body)).toMatchObject({
      artifact: "pull-request",
      number: "12",
      run: "99",
      stage: "review-matrix",
    });
    expect(stageResultStatus(body)).toBe("blocked");
    expect(body).toContain("## GitVibe Risk Accepted");
    expect(body).toContain("**Risk:** `accepted for matching context`");
    expect(body).not.toContain("### Required Fixes");
    expect(parseAcceptedRiskMetadata(body)).toEqual(metadata);
  });

  it("renders compact accepted-risk bodies without optional run fields", () => {
    /** @type {import("../src/shared/accepted-risk.ts").AcceptedRiskMetadata} */
    const metadata = {
      artifact: "issue",
      artifactContentSha: "content-sha",
      cutoff: "2026-01-04T00:00:00Z",
      number: "12",
      stage: "validate",
      stages: ["validate"],
    };

    const body = acceptedRiskStageResultBody(
      { artifact: "issue", number: "12", stage: "validate" },
      metadata,
    );

    expect(parseStageResultMarker(body)).toEqual({
      artifact: "issue",
      number: "12",
      stage: "validate",
    });
    expect(body).toContain("`<unknown>` accepted this prompt-injection input risk");
    expect(body).not.toContain("Accepted workflow run:");
    expect(body).not.toContain("Pull request head SHA:");
    expect(parseAcceptedRiskMetadata(body)).toEqual(metadata);
  });
});
