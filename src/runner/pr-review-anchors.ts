import { paginatedGitHubRequest, splitRepository, type GitHubClient } from "../shared/github.js";
import { summarizeError, type StageLogger } from "./logging.js";
import type { PullRequestReviewComment } from "./pr-review-github.js";

export interface ReviewFindingAnchorInput {
  body: string;
  reviewComment: PullRequestReviewComment;
}

export interface UnanchoredReviewFinding {
  body: string;
  line: number;
  path: string;
  reason: string;
  startLine?: number;
}

interface PullRequestFilePatch {
  filename?: unknown;
  patch?: unknown;
}

interface FileAnchorIndex {
  LEFT: Map<number, number>;
  RIGHT: Map<number, number>;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export async function validateReviewFindingAnchors(options: {
  client: GitHubClient;
  findings: ReviewFindingAnchorInput[];
  logger: StageLogger;
  pullNumber: string;
  repository: string;
  token: string;
}): Promise<{
  comments: PullRequestReviewComment[];
  unanchoredFindings: UnanchoredReviewFinding[];
}> {
  if (!options.findings.length) return { comments: [], unanchoredFindings: [] };

  let index: Map<string, FileAnchorIndex>;
  try {
    index = reviewPatchIndex(
      await pullRequestFilePatches({
        client: options.client,
        pullNumber: options.pullNumber,
        repository: options.repository,
        token: options.token,
      }),
    );
  } catch (error) {
    options.logger.event("github.pr.review.anchors.lookup.failed", {
      comments: options.findings.length,
      error: summarizeError(error),
    });
    return {
      comments: [],
      unanchoredFindings: options.findings.map((finding) =>
        unanchoredReviewFinding(finding, "patch lookup failed"),
      ),
    };
  }

  const comments: PullRequestReviewComment[] = [];
  const unanchoredFindings: UnanchoredReviewFinding[] = [];
  let downgraded = 0;
  for (const finding of options.findings) {
    const comment = { ...finding.reviewComment };
    if (!isReviewLine(index, comment)) {
      unanchoredFindings.push(
        unanchoredReviewFinding(finding, "line is not in the pull request diff"),
      );
      continue;
    }
    if (comment.start_line !== undefined && !isReviewRange(index, comment)) {
      delete comment.start_line;
      delete comment.start_side;
      downgraded += 1;
    }
    comments.push(comment);
  }

  options.logger.event("github.pr.review.anchors.checked", {
    comments: options.findings.length,
    downgraded,
    posted: comments.length,
    unanchored: unanchoredFindings.length,
  });
  return { comments, unanchoredFindings };
}

async function pullRequestFilePatches(options: {
  client: GitHubClient;
  pullNumber: string;
  repository: string;
  token: string;
}): Promise<PullRequestFilePatch[]> {
  const { owner, repo } = splitRepository(options.repository);
  return paginatedGitHubRequest<PullRequestFilePatch>(options.client, {
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/files`,
    token: options.token,
  });
}

function reviewPatchIndex(files: PullRequestFilePatch[]): Map<string, FileAnchorIndex> {
  const index = new Map<string, FileAnchorIndex>();
  for (const file of files) {
    if (typeof file.filename !== "string" || typeof file.patch !== "string") continue;
    index.set(file.filename, fileAnchorIndex(file.patch));
  }
  return index;
}

function fileAnchorIndex(patch: string): FileAnchorIndex {
  const file: FileAnchorIndex = { LEFT: new Map(), RIGHT: new Map() };
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(hunkHeaderPattern);
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (hunk < 0 || line.startsWith("\\")) continue;
    if (line.startsWith(" ")) {
      file.LEFT.set(oldLine, hunk);
      file.RIGHT.set(newLine, hunk);
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("+")) {
      file.RIGHT.set(newLine, hunk);
      newLine += 1;
    } else if (line.startsWith("-")) {
      file.LEFT.set(oldLine, hunk);
      oldLine += 1;
    }
  }
  return file;
}

function isReviewLine(
  index: Map<string, FileAnchorIndex>,
  comment: PullRequestReviewComment,
): boolean {
  return sideHunks(index, comment)?.has(comment.line) || false;
}

function isReviewRange(
  index: Map<string, FileAnchorIndex>,
  comment: PullRequestReviewComment,
): boolean {
  if (comment.start_line === undefined) return true;
  if (comment.start_line > comment.line) return false;
  const hunks = sideHunks(index, comment);
  const startHunk = hunks?.get(comment.start_line);
  return startHunk !== undefined && startHunk === hunks?.get(comment.line);
}

function sideHunks(
  index: Map<string, FileAnchorIndex>,
  comment: PullRequestReviewComment,
): Map<number, number> | undefined {
  return index.get(comment.path)?.[comment.side];
}

function unanchoredReviewFinding(
  finding: ReviewFindingAnchorInput,
  reason: string,
): UnanchoredReviewFinding {
  return {
    body: finding.body,
    line: finding.reviewComment.line,
    path: finding.reviewComment.path,
    reason,
    startLine: finding.reviewComment.start_line,
  };
}
