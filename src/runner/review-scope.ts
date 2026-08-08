import { createHash } from "node:crypto";
import { paginatedGitHubRequest, type GitHubClient } from "../shared/github.js";
import {
  parseStageResultMarker,
  reviewCheckpointVersion,
  stageResultStatus,
} from "../shared/stage-result-markers.js";
import type { JsonObject, PullRequestFile, ReviewRunState, ReviewScope } from "../shared/types.js";

interface PullRequestDetails {
  base?: PullRequestRef;
  head?: PullRequestRef;
}

interface PullRequestRef {
  ref?: string;
  repo?: { full_name?: string } | null;
  sha?: string;
}

interface PullRequestReview {
  body?: string;
  submitted_at?: string;
  user?: { login?: string };
}

interface PullRequestFileResponse {
  additions?: number;
  blob_url?: string;
  changes?: number;
  contents_url?: string;
  deletions?: number;
  filename?: string;
  patch?: string;
  previous_filename?: string;
  raw_url?: string;
  status?: string;
}

interface CompareResponse extends JsonObject {
  files?: PullRequestFileResponse[];
  status?: string;
}

interface ReviewCheckpoint {
  headSha: string;
  submittedAt: string;
}

export async function pullRequestReviewFiles(options: {
  client: GitHubClient;
  name: string;
  owner: string;
  pullNumber: string;
  pullRequest: PullRequestDetails;
  review?: ReviewRunState;
  reviews: PullRequestReview[];
  token: string;
}): Promise<{ files: PullRequestFile[]; scope?: ReviewScope }> {
  const review = options.review;
  if (!review) {
    return { files: await fullPullRequestFiles(options) };
  }

  const current = currentPullRequestState(options.pullRequest);
  validateExpectedReviewState(current, review);
  const targetSha = review.targetSha || current.targetSha;
  const selected = await selectedReviewRange({ ...options, current, review, targetSha });
  const scope = reviewScope({
    baseSha: current.baseSha,
    checkpoint: selected.checkpoint,
    files: selected.files,
    headRepository: current.headRepository,
    targetSha,
  });
  validateExpectedSnapshot(scope, review);
  return { files: selected.files, scope };
}

async function selectedReviewRange(options: {
  client: GitHubClient;
  current: CurrentPullRequestState;
  name: string;
  owner: string;
  pullNumber: string;
  pullRequest: PullRequestDetails;
  review: ReviewRunState;
  reviews: PullRequestReview[];
  targetSha: string;
  token: string;
}): Promise<{ checkpoint?: ReviewCheckpoint; files: PullRequestFile[] }> {
  const candidates = checkpointCandidates(options.reviews, options.current.baseSha);
  if (options.review.snapshotSha) {
    if (!options.review.checkpointSha) {
      return { files: await fullPullRequestFiles(options) };
    }
    const checkpointSha = requiredSha(options.review.checkpointSha, "review checkpoint SHA");
    const checkpoint = candidates.find((candidate) => candidate.headSha === checkpointSha);
    if (!checkpoint) {
      throw new Error(`Completed review checkpoint ${checkpointSha} is no longer available.`);
    }
    const compared = await comparisonRange({ ...options, checkpoint, strict: true });
    if (!compared) throw new Error(`Unable to reconstruct review checkpoint ${checkpointSha}.`);
    return compared;
  }
  if (options.review.checkpointSha) {
    throw new Error("A frozen review checkpoint requires a snapshot SHA.");
  }

  for (const checkpoint of candidates) {
    const compared = await comparisonRange({ ...options, checkpoint, strict: false });
    if (compared) return compared;
  }
  return { files: await fullPullRequestFiles(options) };
}

async function comparisonRange(options: {
  checkpoint: ReviewCheckpoint;
  client: GitHubClient;
  name: string;
  owner: string;
  strict: boolean;
  targetSha: string;
  token: string;
}): Promise<{ checkpoint: ReviewCheckpoint; files: PullRequestFile[] } | undefined> {
  if (options.checkpoint.headSha === options.targetSha) {
    return { checkpoint: options.checkpoint, files: [] };
  }
  const comparison = await options.client.request<CompareResponse>({
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/compare/${options.checkpoint.headSha}...${options.targetSha}`,
    token: options.token,
  });
  if (comparison.status !== "ahead") {
    if (!options.strict) return undefined;
    throw new Error(
      `Review checkpoint ${options.checkpoint.headSha} is not an ancestor of target ${options.targetSha}.`,
    );
  }
  if (!Array.isArray(comparison.files)) {
    throw new Error("GitHub compare response was missing changed files.");
  }
  if (comparison.files.length >= 300) {
    if (!options.strict) return undefined;
    throw new Error("GitHub compare response reached the 300-file limit.");
  }
  return { checkpoint: options.checkpoint, files: pullRequestFiles(comparison.files) };
}

async function fullPullRequestFiles(options: {
  client: GitHubClient;
  name: string;
  owner: string;
  pullNumber: string;
  token: string;
}): Promise<PullRequestFile[]> {
  const files = await paginatedGitHubRequest<PullRequestFileResponse>(options.client, {
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/pulls/${options.pullNumber}/files`,
    token: options.token,
  });
  return pullRequestFiles(files);
}

function checkpointCandidates(reviews: PullRequestReview[], baseSha: string): ReviewCheckpoint[] {
  return reviews
    .flatMap((review) => {
      if (
        !gitVibeReviewAuthor(review.user?.login) ||
        stageResultStatus(review.body) !== "completed"
      ) {
        return [];
      }
      const marker = parseStageResultMarker(review.body);
      if (
        marker?.stage !== "review-matrix" ||
        marker.artifact !== "pull-request" ||
        marker.reviewVersion !== reviewCheckpointVersion ||
        marker.baseSha !== baseSha ||
        !validSha(marker.headSha) ||
        !validDigest(marker.snapshotSha)
      ) {
        return [];
      }
      return [
        {
          headSha: marker.headSha,
          submittedAt: review.submitted_at || "",
        },
      ];
    })
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

interface CurrentPullRequestState {
  baseSha: string;
  headRepository: string;
  targetSha: string;
}

function currentPullRequestState(pullRequest: PullRequestDetails): CurrentPullRequestState {
  return {
    baseSha: requiredSha(pullRequest.base?.sha, "pull request base SHA"),
    headRepository: requiredText(pullRequest.head?.repo?.full_name, "pull request head repository"),
    targetSha: requiredSha(pullRequest.head?.sha, "pull request head SHA"),
  };
}

function validateExpectedReviewState(
  current: CurrentPullRequestState,
  review: ReviewRunState,
): void {
  if (review.targetSha && review.targetSha !== current.targetSha) {
    throw new Error(
      `Review target ${review.targetSha} was superseded by pull request head ${current.targetSha}.`,
    );
  }
  if (review.baseSha && review.baseSha !== current.baseSha) {
    throw new Error(
      `Review base ${review.baseSha} was superseded by pull request base ${current.baseSha}.`,
    );
  }
}

function validateExpectedSnapshot(scope: ReviewScope, review: ReviewRunState): void {
  if (review.snapshotSha && review.snapshotSha !== scope.snapshotSha) {
    throw new Error(
      `Review snapshot ${review.snapshotSha} did not match reconstructed snapshot ${scope.snapshotSha}.`,
    );
  }
}

function reviewScope(options: {
  baseSha: string;
  checkpoint?: ReviewCheckpoint;
  files: PullRequestFile[];
  headRepository: string;
  targetSha: string;
}): ReviewScope {
  const snapshotSha = createHash("sha256")
    .update(
      JSON.stringify({
        baseSha: options.baseSha,
        checkpointSha: options.checkpoint?.headSha || "",
        files: [...options.files].sort(compareFiles).map(fileSnapshot),
        headRepository: options.headRepository,
        targetSha: options.targetSha,
      }),
    )
    .digest("hex");
  return {
    baseSha: options.baseSha,
    ...(options.checkpoint
      ? {
          checkpointSha: options.checkpoint.headSha,
          ...(options.checkpoint.submittedAt
            ? { checkpointSubmittedAt: options.checkpoint.submittedAt }
            : {}),
        }
      : {}),
    headRepository: options.headRepository,
    snapshotSha,
    targetSha: options.targetSha,
  };
}

function fileSnapshot(file: PullRequestFile): Record<string, unknown> {
  return {
    additions: file.additions,
    changes: file.changes,
    deletions: file.deletions,
    filename: file.filename,
    patch: file.patch,
    previousFilename: file.previousFilename,
    status: file.status,
  };
}

function compareFiles(left: PullRequestFile, right: PullRequestFile): number {
  return left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0;
}

function pullRequestFiles(files: PullRequestFileResponse[]): PullRequestFile[] {
  return files.map(toPullRequestFile).filter((file): file is PullRequestFile => Boolean(file));
}

function toPullRequestFile(file: PullRequestFileResponse): PullRequestFile | undefined {
  const filename = text(file.filename);
  if (!filename) return undefined;
  return {
    additions: number(file.additions),
    blobUrl: text(file.blob_url),
    changes: number(file.changes),
    contentsUrl: text(file.contents_url),
    deletions: number(file.deletions),
    filename,
    patch: text(file.patch),
    previousFilename: text(file.previous_filename),
    rawUrl: text(file.raw_url),
    status: text(file.status) || "modified",
  };
}

function gitVibeReviewAuthor(value: string | undefined): boolean {
  const login = text(value).toLowerCase();
  return login === "gitvibe-for-github" || login === "gitvibe-for-github[bot]";
}

function requiredSha(value: string | undefined, label: string): string {
  if (!validSha(value)) throw new Error(`GitHub did not provide a valid ${label}.`);
  return value;
}

function validSha(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{40,64}$/i.test(value));
}

function validDigest(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function requiredText(value: string | undefined, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`GitHub did not provide a valid ${label}.`);
  return result;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
