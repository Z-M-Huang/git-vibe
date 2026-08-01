import { splitRepository, type GitHubClient } from "../shared/github.js";
import type { ContextPacket, RunnerOptions } from "../shared/types.js";

export async function assertCurrentReviewTarget(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<void> {
  const targetSha = guardedTargetSha(options.context, options.runner);
  if (!targetSha) return;
  const currentSha = await pullRequestHeadSha(options);
  if (currentSha !== targetSha) {
    throw new Error(
      `Review target ${targetSha} was superseded by pull request head ${currentSha}.`,
    );
  }
}

function guardedTargetSha(context: ContextPacket, runner: RunnerOptions): string | undefined {
  if (runner.stage !== "review-matrix" || context.artifact.type !== "pull-request")
    return undefined;
  return context.reviewScope?.targetSha;
}

async function pullRequestHeadSha(options: {
  client: GitHubClient;
  context: ContextPacket;
  runner: RunnerOptions;
}): Promise<string> {
  const { owner, repo } = splitRepository(options.runner.repository);
  const pullRequest = await options.client.request<{ head?: { sha?: string } }>({
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls/${options.context.artifact.number}`,
    token: options.runner.token,
  });
  const sha = pullRequest.head?.sha?.trim();
  if (!sha) throw new Error("GitHub pull request response was missing the current head SHA.");
  return sha;
}
