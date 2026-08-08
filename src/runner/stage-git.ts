import { execFileSync } from "node:child_process";

export function repositoryContext(cwd: string, expectedHead?: string): string {
  if (!expectedHead)
    return execFileSync("git", ["status", "--short", "--branch"], { cwd }).toString();
  const head = gitOutput(cwd, ["rev-parse", "HEAD"]);
  if (head !== expectedHead) {
    throw new Error(`Review workspace HEAD ${head} did not match target ${expectedHead}.`);
  }
  const status = gitOutput(cwd, ["status", "--short", "--branch"]);
  return [`Workspace: ${cwd}`, `HEAD: ${head}`, status].filter(Boolean).join("\n");
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd }).toString().trim();
}
