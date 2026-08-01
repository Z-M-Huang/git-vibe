import { type GitHubClient, splitRepository } from "../shared/github.js";

export interface PullRequestReviewComment {
  body: string;
  line: number;
  path: string;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

export async function createPullRequestReview(options: {
  body: string;
  client: GitHubClient;
  commitId?: string;
  comments: PullRequestReviewComment[];
  pullNumber: string;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: {
      body: options.body,
      comments: options.comments.length ? options.comments : undefined,
      commit_id: options.commitId,
      event: "COMMENT",
    },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/reviews`,
    token: options.token,
  });
}

export async function updatePullRequestReview(options: {
  body: string;
  client: GitHubClient;
  pullNumber: string;
  repository: string;
  reviewId: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: { body: options.body },
    method: "PUT",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/reviews/${options.reviewId}`,
    token: options.token,
  });
}
