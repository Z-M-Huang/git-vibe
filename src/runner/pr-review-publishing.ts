import { GitHubClient, isGitHubGraphQLForbiddenError, splitRepository } from "../shared/github.js";
import { workflowRunIdFromUrl } from "../shared/status-comments.js";
import type { ContextPacket, JsonObject, RunnerOptions } from "../shared/types.js";
import type { StageLogger } from "./logging.js";
import { validateReviewFindingAnchors, type UnanchoredReviewFinding } from "./pr-review-anchors.js";
import {
  effectiveReviewFindingId,
  normalizedFindingId,
  reviewFindingMarker,
  reviewFindingMarkerId,
  reviewFindingUnanchoredMarker,
  visibleReviewCommentBody,
} from "./review-finding-ids.js";
import {
  createPullRequestReview,
  type PullRequestReviewComment,
  updatePullRequestReview,
} from "./pr-review-github.js";
import { assertCurrentReviewTarget } from "./review-target.js";

interface ReviewFindingComment {
  body: string;
  findingId: string;
  reviewComment: PullRequestReviewComment;
}

interface PriorReviewFinding {
  commentDatabaseId: string;
  findingId: string;
  reviewThreadId: string;
  updateKeys: Set<string>;
}

interface AuthenticatedUserResponse extends JsonObject {
  login?: string;
}

interface ReviewedCommit {
  label: string;
  markerSha: string;
}

type ReviewFindingUpdateStatus = "outdated" | "still-present";

const gitVibeAppReviewAuthors = ["gitvibe-for-github", "gitvibe-for-github[bot]"];

export function assertPullRequestReviewResultPublishable(options: {
  context: ContextPacket;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): void {
  if (!shouldPublishPullRequestReview(options)) return;
  reviewFindingComments(options.parsedOutput.inline_comments);
}

export async function publishPullRequestReviewResult(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
  stageResultBody: string;
}): Promise<boolean> {
  if (!shouldPublishPullRequestReview(options)) return false;

  const findings = reviewFindingComments(options.parsedOutput.inline_comments);
  const reconciliation = shouldReconcileReviewFindings(options.parsedOutput)
    ? await planReviewFindingReconciliation({ ...options, findings })
    : undefined;
  const newFindings = reconciliation?.newFindings || findings;
  const validated = await validateReviewFindingAnchors({
    client: options.client,
    findings: newFindings,
    logger: options.logger,
    pullNumber: options.context.artifact.number,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  const comments = validated.comments;
  const body = pullRequestReviewBody({
    comments,
    output: options.parsedOutput,
    stageResultBody: options.stageResultBody,
    unanchoredFindings: validated.unanchoredFindings,
    workflowRunUrl: options.runner.workflowRunUrl,
  });
  const existingReview = await editableReviewForStageResult({ ...options, comments });
  await assertCurrentReviewTarget(options);
  if (existingReview) {
    options.logger.event("github.pr.review.update.start", {
      pull_request: options.context.artifact.number,
      review: existingReview.reviewId,
      run: workflowRunIdFromUrl(options.runner.workflowRunUrl),
    });
    await updatePullRequestReview({
      body,
      client: options.client,
      pullNumber: options.context.artifact.number,
      repository: options.runner.repository,
      reviewId: existingReview.reviewId,
      token: options.runner.token,
    });
    options.logger.event("github.pr.review.update.done", {
      pull_request: options.context.artifact.number,
      review: existingReview.reviewId,
      run: workflowRunIdFromUrl(options.runner.workflowRunUrl),
    });
  } else {
    options.logger.event("github.pr.review.start", {
      comments: comments.length,
      pull_request: options.context.artifact.number,
    });
    await createPullRequestReview({
      body,
      client: options.client,
      comments,
      commitId: options.context.reviewScope?.targetSha,
      pullNumber: options.context.artifact.number,
      repository: options.runner.repository,
      token: options.runner.token,
    });
    options.logger.event("github.pr.review.done", {
      comments: comments.length,
      pull_request: options.context.artifact.number,
    });
  }
  await reconciliation?.apply();
  return true;
}

function shouldPublishPullRequestReview(options: {
  context: ContextPacket;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): boolean {
  return (
    options.runner.stage === "review-matrix" && options.context.artifact.type === "pull-request"
  );
}

function shouldReconcileReviewFindings(output: JsonObject): boolean {
  return (
    String(output.status || "")
      .trim()
      .toLowerCase() === "completed"
  );
}

async function editableReviewForStageResult(options: {
  client: GitHubClient;
  comments: PullRequestReviewComment[];
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<{ reviewId: string } | undefined> {
  if (options.comments.length > 0) return undefined;
  const run = workflowRunIdFromUrl(options.runner.workflowRunUrl);
  if (!run) return undefined;
  const candidates: Array<{ author: string; reviewId: string }> = [];
  for (const item of options.context.timeline) {
    if (item.kind !== "pull-request-review") continue;
    const reviewId = reviewDatabaseId(item.databaseId);
    if (!reviewId) continue;
    const marker = parseStageResultMarker(item.body);
    if (
      marker?.artifact === options.context.artifact.type &&
      marker.number === options.context.artifact.number &&
      marker.stage === options.runner.stage &&
      markerMatchesRun(marker, item.body, run) &&
      reviewInlineCommentCount(item.body) === 0
    ) {
      candidates.push({ author: item.author, reviewId });
    }
  }
  if (!candidates.length) return undefined;

  const login = await authenticatedGitHubLogin({
    client: options.client,
    eventName: "github.pr.review.update.skip",
    logger: options.logger,
    token: options.runner.token,
  });
  if (!login) return undefined;
  let editableReview: { reviewId: string } | undefined;
  for (const candidate of candidates) {
    if (sameGitHubLogin(candidate.author, login)) {
      editableReview = { reviewId: candidate.reviewId };
    }
  }
  return editableReview;
}

function parseStageResultMarker(
  body: string,
): { artifact: string; number: string; run?: string; stage: string } | undefined {
  const attributes = markerAttributes(body, "git-vibe:stage-result");
  if (!attributes.stage || !attributes.artifact || !attributes.number) return undefined;
  return {
    artifact: attributes.artifact,
    number: attributes.number,
    run: attributes.run,
    stage: attributes.stage,
  };
}

function markerMatchesRun(marker: { run?: string }, body: string, run: string): boolean {
  if (marker.run) return marker.run === run;
  return body.includes(`/actions/runs/${run}`);
}

function reviewInlineCommentCount(body: string): number {
  const match = body.match(/\*\*Inline comments:\*\*\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function reviewDatabaseId(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return undefined;
}

function sameGitHubLogin(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function authenticatedGitHubLogin(options: {
  client: GitHubClient;
  eventName: string;
  logger: StageLogger;
  token: string;
}): Promise<string | undefined> {
  let user: AuthenticatedUserResponse;
  try {
    user = await options.client.request<AuthenticatedUserResponse>({
      method: "GET",
      path: "/user",
      token: options.token,
    });
  } catch {
    options.logger.event(options.eventName, {
      reason: "unknown-token-author",
    });
    return undefined;
  }
  const login = stringField(user.login);
  if (!login) {
    options.logger.event(options.eventName, {
      reason: "unknown-token-author",
    });
    return undefined;
  }
  return login;
}

async function planReviewFindingReconciliation(options: {
  client: GitHubClient;
  context: ContextPacket;
  findings: ReviewFindingComment[];
  logger: StageLogger;
  parsedOutput: JsonObject;
  runner: RunnerOptions;
}): Promise<{ apply: () => Promise<void>; newFindings: ReviewFindingComment[] }> {
  const priorFindings = await priorReviewFindings(options);
  const commit = reviewedCommit(options.context);
  const currentFindingIds = new Set(options.findings.map((finding) => finding.findingId));
  const resolvedFindingIds = new Set(stringItems(options.parsedOutput.resolved_finding_ids));
  const newFindings: ReviewFindingComment[] = [];
  const updates: Array<() => Promise<void>> = [];

  for (const finding of options.findings) {
    const prior = priorFindings.get(finding.findingId);
    if (!prior) {
      newFindings.push(finding);
      continue;
    }
    updates.push(() =>
      replyToPriorReviewFinding({
        ...options,
        body: stillPresentReviewFindingReply(finding.body, commit.label),
        commit,
        prior,
        status: "still-present",
      }),
    );
  }

  for (const prior of priorFindings.values()) {
    if (currentFindingIds.has(prior.findingId)) continue;
    if (options.context.reviewScope?.checkpointSha && !resolvedFindingIds.has(prior.findingId)) {
      options.logger.event("github.pr.review_thread.reconcile.skip", {
        finding: prior.findingId,
        reason: "incremental-review-carried",
      });
      continue;
    }
    updates.push(async () => {
      await replyToPriorReviewFinding({
        ...options,
        body: outdatedReviewFindingReply(commit.label),
        commit,
        prior,
        status: "outdated",
      });
      await resolveReviewThread({
        client: options.client,
        logger: options.logger,
        reviewThreadId: prior.reviewThreadId,
        token: options.runner.token,
      });
    });
  }

  return {
    apply: async () => {
      if (!updates.length) return;
      await assertCurrentReviewTarget(options);
      for (const update of updates) await update();
    },
    newFindings,
  };
}

async function priorReviewFindings(options: {
  client: GitHubClient;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): Promise<Map<string, PriorReviewFinding>> {
  const candidates = priorReviewFindingCandidates(options.context);
  if (!candidates.length) return new Map();

  const findings = new Map<string, PriorReviewFinding>();
  const updates = reviewFindingUpdatesByThread(options.context);
  for (const candidate of candidates) {
    if (!isGitVibeAppReviewAuthor(candidate.author)) continue;
    findings.set(candidate.findingId, {
      ...candidate,
      updateKeys: updates.get(candidate.reviewThreadId) || new Set(),
    });
  }
  return findings;
}

function priorReviewFindingCandidates(
  context: ContextPacket,
): Array<Omit<PriorReviewFinding, "updateKeys"> & { author: string }> {
  const candidates: Array<Omit<PriorReviewFinding, "updateKeys"> & { author: string }> = [];
  for (const item of context.timeline) {
    if (item.kind !== "pull-request-review-comment" || item.parentId) continue;
    const findingId = reviewFindingMarkerId(item.body);
    const reviewThreadId = stringField(item.reviewThreadId);
    const commentDatabaseId = reviewCommentDatabaseId(item.databaseId);
    if (!findingId || !reviewThreadId || !commentDatabaseId) continue;
    candidates.push({
      author: item.author,
      commentDatabaseId,
      findingId,
      reviewThreadId,
    });
  }
  return candidates;
}

function reviewFindingUpdatesByThread(context: ContextPacket): Map<string, Set<string>> {
  const updates = new Map<string, Set<string>>();
  for (const item of context.timeline) {
    if (item.kind !== "pull-request-review-comment" || !item.reviewThreadId) continue;
    if (!isGitVibeAppReviewAuthor(item.author)) continue;
    const marker = parseReviewFindingUpdateMarker(item.body);
    if (!marker) continue;
    const key = reviewFindingUpdateKey(marker);
    const threadUpdates = updates.get(item.reviewThreadId) || new Set<string>();
    threadUpdates.add(key);
    updates.set(item.reviewThreadId, threadUpdates);
  }
  return updates;
}

async function replyToPriorReviewFinding(options: {
  body: string;
  client: GitHubClient;
  commit: ReviewedCommit;
  context: ContextPacket;
  logger: StageLogger;
  prior: PriorReviewFinding;
  runner: RunnerOptions;
  status: ReviewFindingUpdateStatus;
}): Promise<void> {
  const update = {
    id: options.prior.findingId,
    sha: options.commit.markerSha,
    status: options.status,
  };
  const updateKey = reviewFindingUpdateKey(update);
  if (options.prior.updateKeys.has(updateKey)) {
    options.logger.event("github.pr.review_thread.reply.skip", {
      finding: options.prior.findingId,
      reason: "duplicate-update",
      status: options.status,
    });
    return;
  }

  options.logger.event("github.pr.review_thread.reply.start", {
    finding: options.prior.findingId,
    pull_request: options.context.artifact.number,
    status: options.status,
  });
  await createPullRequestReviewReply({
    body: `${reviewFindingUpdateMarker(update)}\n${options.body}`,
    client: options.client,
    commentId: options.prior.commentDatabaseId,
    pullNumber: options.context.artifact.number,
    repository: options.runner.repository,
    token: options.runner.token,
  });
  options.prior.updateKeys.add(updateKey);
  options.logger.event("github.pr.review_thread.reply.done", {
    finding: options.prior.findingId,
    pull_request: options.context.artifact.number,
    status: options.status,
  });
}

async function createPullRequestReviewReply(options: {
  body: string;
  client: GitHubClient;
  commentId: string;
  pullNumber: string;
  repository: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = splitRepository(options.repository);
  await options.client.request({
    body: { body: options.body },
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls/${options.pullNumber}/comments/${options.commentId}/replies`,
    token: options.token,
  });
}

async function resolveReviewThread(options: {
  client: GitHubClient;
  logger: StageLogger;
  reviewThreadId: string;
  token: string;
}): Promise<void> {
  const thread = options.reviewThreadId;
  options.logger.event("github.pr.review_thread.resolve.start", { thread });
  try {
    await options.client.graphql(resolveReviewThreadMutation, { threadId: thread }, options.token);
  } catch (error) {
    if (isGitHubGraphQLForbiddenError(error, "resolveReviewThread")) {
      options.logger.event("github.pr.review_thread.resolve.skip", { reason: "forbidden", thread });
      return;
    }
    throw error;
  }
  options.logger.event("github.pr.review_thread.resolve.done", { thread });
}

function reviewFindingComments(value: unknown): ReviewFindingComment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("review-matrix inline_comments must be an array.");
  }
  const comments = value.map((item, index) => reviewFindingComment(item, index));
  const findingIds = new Set<string>();
  for (const comment of comments) {
    if (findingIds.has(comment.findingId)) {
      throw new Error(
        `review-matrix inline_comments finding_id must be unique: ${comment.findingId}.`,
      );
    }
    findingIds.add(comment.findingId);
  }
  return comments;
}

function reviewFindingComment(value: unknown, index: number): ReviewFindingComment {
  if (!isRecord(value)) {
    throw new Error(`review-matrix inline_comments[${index}] must be an object.`);
  }
  const path = stringField(value.path);
  const rawBody = stringField(value.body);
  const body = visibleReviewCommentBody(rawBody);
  const line = integerField(value.line);
  if (!path || !body || line === undefined) {
    throw new Error(`review-matrix inline_comments[${index}] must define path, line, and body.`);
  }

  const side = sideField(value.side);
  const reviewComment: PullRequestReviewComment = { body, line, path, side };
  const startLine = integerField(value.start_line);
  if (startLine !== undefined) {
    reviewComment.start_line = startLine;
    reviewComment.start_side = side;
  }
  const explicitFindingId = value.finding_id;
  const normalizedExplicitFindingId = normalizedFindingId(explicitFindingId);
  if (explicitFindingId !== undefined && !normalizedExplicitFindingId) {
    throw new Error(
      `review-matrix inline_comments[${index}].finding_id must match the allowed pattern.`,
    );
  }
  const findingId = effectiveReviewFindingId({
    body,
    explicitFindingId,
    line,
    path,
    rawBody,
    startLine,
  });
  reviewComment.body = `${reviewFindingMarker(findingId)}\n${body}`;
  return { body, findingId, reviewComment };
}

function isGitVibeAppReviewAuthor(login: string): boolean {
  return gitVibeAppReviewAuthors.some((author) => sameGitHubLogin(login, author));
}

function reviewFindingUpdateMarker(options: {
  id: string;
  sha: string;
  status: ReviewFindingUpdateStatus;
}): string {
  return `<!-- git-vibe:review-finding-update id=${options.id} status=${options.status} sha=${options.sha} -->`;
}

function parseReviewFindingUpdateMarker(
  body: string,
): { id: string; sha: string; status: ReviewFindingUpdateStatus } | undefined {
  const attributes = markerAttributes(body, "git-vibe:review-finding-update");
  const id = normalizedFindingId(attributes.id);
  const sha = normalizedFindingMarkerValue(attributes.sha);
  const status = reviewFindingUpdateStatus(attributes.status);
  if (!id || !sha || !status) return undefined;
  return { id, sha, status };
}

function markerAttributes(body: string, marker: string): Record<string, string> {
  const match = body.match(new RegExp(`<!--\\s*${marker}\\s+([^>]*)-->`));
  if (!match) return {};
  return Object.fromEntries(
    [...(match[1] || "").matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)].map((entry) => [
      entry[1],
      entry[2],
    ]),
  );
}

function reviewFindingUpdateStatus(value: unknown): ReviewFindingUpdateStatus | undefined {
  return value === "outdated" || value === "still-present" ? value : undefined;
}

function reviewFindingUpdateKey(options: {
  id: string;
  sha: string;
  status: ReviewFindingUpdateStatus;
}): string {
  return `${options.id}:${options.status}:${options.sha}`;
}

function normalizedFindingMarkerValue(value: unknown): string | undefined {
  const markerValue = stringField(value);
  return /^[A-Za-z0-9._:-]+$/.test(markerValue) ? markerValue : undefined;
}

function reviewCommentDatabaseId(value: number | string | undefined): string | undefined {
  return reviewDatabaseId(value);
}

function reviewedCommit(context: ContextPacket): ReviewedCommit {
  const sha = stringField(context.artifact.pullRequestHead?.sha);
  if (!sha) return { label: "the latest reviewed commit", markerSha: "latest" };
  const shortSha = sha.slice(0, 12);
  return { label: `commit \`${shortSha}\``, markerSha: shortSha };
}

function stillPresentReviewFindingReply(body: string, commitLabel: string): string {
  return cleanLines([`This issue still exists after ${commitLabel}.`, "", body]).join("\n");
}

function outdatedReviewFindingReply(commitLabel: string): string {
  return `This GitVibe finding is outdated after ${commitLabel}; the latest review no longer reports this issue.`;
}

function pullRequestReviewBody(options: {
  comments: PullRequestReviewComment[];
  output: JsonObject;
  stageResultBody: string;
  unanchoredFindings: UnanchoredReviewFinding[];
  workflowRunUrl?: string;
}): string {
  const findings = stringItems(options.output.findings);
  return cleanLines([
    ...options.stageResultBody.split(/\r?\n/),
    ...reviewDetailsSection({
      comments: options.comments,
      findings,
      unanchoredFindings: options.unanchoredFindings,
    }),
    ...fallbackWorkflowRunSection(options.stageResultBody, options.workflowRunUrl),
  ]).join("\n");
}

function reviewDetailsSection(options: {
  comments: PullRequestReviewComment[];
  findings: string[];
  unanchoredFindings: UnanchoredReviewFinding[];
}): string[] {
  if (!options.comments.length && !options.findings.length && !options.unanchoredFindings.length) {
    return [];
  }
  return [
    "",
    `**Inline comments:** ${options.comments.length}`,
    ...findingsSection(options.findings),
    ...unanchoredFindingsSection(options.unanchoredFindings),
  ];
}

function findingsSection(findings: string[]): string[] {
  if (!findings.length) return [];
  return [
    "",
    "### Required Fixes",
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
  ];
}

function unanchoredFindingsSection(findings: UnanchoredReviewFinding[]): string[] {
  if (!findings.length) return [];
  return [
    "",
    "### Unanchored Inline Findings",
    ...findings.flatMap((finding, index) => [
      `${index + 1}. \`${finding.path}:${lineRange(finding)}\` (${finding.reason}) ${reviewFindingUnanchoredMarker(finding.findingId)}`,
      ...finding.body.split(/\r?\n/).map((line) => `   ${line}`),
    ]),
  ];
}

function lineRange(finding: UnanchoredReviewFinding): string {
  return finding.startLine ? `${finding.startLine}-${finding.line}` : String(finding.line);
}

function fallbackWorkflowRunSection(body: string, url: string | undefined): string[] {
  if (!url || body.includes(`Workflow run: ${url}`)) return [];
  return ["", `Workflow run: ${url}`];
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sideField(value: unknown): "LEFT" | "RIGHT" {
  return value === "LEFT" || value === "RIGHT" ? value : "RIGHT";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanLines(lines: string[]): string[] {
  const cleaned: string[] = [];
  for (const line of lines) {
    if (!line && cleaned.at(-1) === "") continue;
    cleaned.push(line);
  }
  while (cleaned.at(-1) === "") cleaned.pop();
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveReviewThreadMutation = `
  mutation GitVibeResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
      }
    }
  }
`;
