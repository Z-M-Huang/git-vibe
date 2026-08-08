import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryContext } from "../src/runner/stage-git.ts";

describe("review workspace repository context", () => {
  it("accepts the frozen target and rejects a different checkout", () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-review-workspace-"));
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "git-vibe@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "GitVibe"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "content");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();

    expect(repositoryContext(cwd, head)).toContain(`HEAD: ${head}`);
    expect(() => repositoryContext(cwd, "f".repeat(40))).toThrow(
      `Review workspace HEAD ${head} did not match target`,
    );
  });
});
