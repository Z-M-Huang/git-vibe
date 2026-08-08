import { describe, expect, it } from "vitest";
import { loadStageSchema, validateOutput } from "../src/runner/schemas.ts";
import { stageDefinitions } from "../src/shared/stages.ts";

describe("review-matrix contract", () => {
  it("validates optional inline pull request review comments", async () => {
    const schema = loadStageSchema(stageDefinitions["review-matrix"].schemaFile);
    const output = {
      assumptions: [],
      comment_body: "Required fix details.",
      findings: ["src/app.ts:42 does not handle pull_request.labeled."],
      inline_comments: [
        {
          body: "Handle `pull_request.labeled` here so adding `git-vibe:review` to a PR starts review.",
          finding_id: "review-1",
          line: 42,
          path: "src/app.ts",
          severity: "high",
        },
      ],
      next_state: "changes-required",
      references: ["src/app.ts"],
      resolved_finding_ids: ["prior-review-2"],
      stage: "review-matrix",
      status: "completed",
      summary: "Review found required changes.",
      tests: ["corepack pnpm test"],
    };

    await expect(
      validateOutput({
        content: JSON.stringify(output),
        schema,
        schemaId: stageDefinitions["review-matrix"].schemaId,
      }),
    ).resolves.toMatchObject({ inline_comments: [expect.objectContaining({ line: 42 })] });

    await expect(
      validateOutput({
        content: JSON.stringify({
          ...output,
          inline_comments: [{ body: "Missing anchor.", line: 42 }],
        }),
        schema,
        schemaId: stageDefinitions["review-matrix"].schemaId,
      }),
    ).rejects.toThrow("AI output failed review-matrix.v1 validation");

    await expect(
      validateOutput({
        content: JSON.stringify({ ...output, next_state: "review-passed" }),
        schema,
        schemaId: stageDefinitions["review-matrix"].schemaId,
      }),
    ).rejects.toThrow("AI output failed review-matrix.v1 validation");

    await expect(
      validateOutput({
        content: JSON.stringify({ ...output, next_state: "blocked", status: "blocked" }),
        schema,
        schemaId: stageDefinitions["review-matrix"].schemaId,
      }),
    ).resolves.toMatchObject({ next_state: "blocked", status: "blocked" });

    await expect(
      validateOutput({
        content: JSON.stringify({ ...output, resolved_finding_ids: ["invalid id"] }),
        schema,
        schemaId: stageDefinitions["review-matrix"].schemaId,
      }),
    ).rejects.toThrow("AI output failed review-matrix.v1 validation");

    expect(schema).toMatchObject({
      properties: {
        inline_comments: {
          description: expect.stringContaining("finding_id must be unique"),
          items: {
            properties: {
              line: { description: expect.stringContaining("final line") },
              start_line: { description: expect.stringContaining("less than or equal") },
            },
          },
        },
        resolved_finding_ids: {
          description: expect.stringContaining("already closed and must not be repeated"),
        },
      },
    });
  });
});
