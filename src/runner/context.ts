import { GitHubClient, paginatedGitHubRequest, splitRepository } from "../shared/github.js";
import {
  gitVibeTraceabilityIssueNumbers,
  sourceDiscussionTraceFromBody,
} from "../shared/traceability.js";
import { stageDefinitions } from "../shared/stages.js";
import type {
  ContextPacket,
  JsonObject,
  ReviewRunState,
  RunnerOptions,
  TimelineItem,
} from "../shared/types.js";
import {
  discussionContext,
  pullRequestReviewContext,
  type DiscussionNode,
  type PullRequestReviewCommentNode,
} from "./context-graphql.js";
import { pullRequestReviewFiles } from "./review-scope.js";

interface IssueResponse extends JsonObject {
  author_association?: string;
  body?: string;
  created_at?: string;
  html_url?: string;
  labels?: Array<{ name?: string } | string>;
  number?: number;
  reactions?: JsonObject;
  title?: string;
  updated_at?: string;
  user?: { login?: string };
}

interface CommentResponse extends IssueResponse {
  id?: number;
}

interface PullRequestResponse extends JsonObject {
  base?: {
    ref?: string;
    repo?: { full_name?: string } | null;
    sha?: string;
  };
  head?: {
    ref?: string;
    repo?: {
      full_name?: string;
      name?: string;
      owner?: { login?: string };
    } | null;
    sha?: string;
  };
}

interface PullRequestReviewResponse extends JsonObject {
  author_association?: string;
  body?: string;
  html_url?: string;
  id?: number;
  node_id?: string;
  submitted_at?: string;
  user?: { login?: string };
}

interface BuildIssueContextOptions {
  client: GitHubClient;
  issueNumber: string;
  review?: ReviewRunState;
  repository: string;
  token: string;
  type?: "issue" | "pull-request";
}

export async function contextForStage(
  client: GitHubClient,
  options: RunnerOptions,
): Promise<ContextPacket> {
  const definition = stageDefinitions[options.stage];
  if (
    options.stage === "validate" &&
    process.env.GITVIBE_DISCUSSION_NUMBER &&
    !options.issueNumber
  ) {
    return buildDiscussionContext({
      client,
      discussionNumber: process.env.GITVIBE_DISCUSSION_NUMBER,
      repository: options.repository,
      token: options.token,
    });
  }
  if (definition.target === "discussion") {
    return buildDiscussionContext({
      client,
      discussionNumber: process.env.GITVIBE_DISCUSSION_NUMBER || options.issueNumber,
      repository: options.repository,
      token: options.token,
    });
  }
  if ((options.stage === "review-matrix" || options.stage === "investigate") && options.prNumber) {
    return buildIssueContext({
      client,
      issueNumber: options.prNumber,
      review: options.stage === "review-matrix" ? options.review : undefined,
      repository: options.repository,
      token: options.token,
      type: "pull-request",
    });
  }
  return buildIssueContext({
    client,
    issueNumber: definition.target === "pull-request" ? options.prNumber : options.issueNumber,
    repository: options.repository,
    token: options.token,
    type: definition.target,
  });
}

export async function buildIssueContext(options: BuildIssueContextOptions): Promise<ContextPacket> {
  const { owner, repo } = splitRepository(options.repository);
  const issue = await options.client.request<IssueResponse>({
    method: "GET",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}`,
    token: options.token,
  });
  const comments = await paginatedGitHubRequest<CommentResponse>(options.client, {
    method: "GET",
    path: `/repos/${owner}/${repo}/issues/${options.issueNumber}/comments`,
    token: options.token,
  });
  const pullRequest =
    options.type === "pull-request"
      ? await pullRequestDetails({
          client: options.client,
          issueNumber: options.issueNumber,
          name: repo,
          owner,
          token: options.token,
        })
      : undefined;
  const reviewContext =
    options.type === "pull-request"
      ? await pullRequestReviewContext({
          client: options.client,
          name: repo,
          owner,
          pullNumber: options.issueNumber,
          token: options.token,
        })
      : { comments: [], resolvedFindingIds: [] };
  const reviews =
    options.type === "pull-request"
      ? await pullRequestReviews({
          client: options.client,
          name: repo,
          owner,
          pullNumber: options.issueNumber,
          token: options.token,
        })
      : [];
  const relatedTimeline =
    options.type === "pull-request"
      ? await pullRequestRelatedTimeline({
          client: options.client,
          issue,
          name: repo,
          owner,
          prNumber: options.issueNumber,
          repository: options.repository,
          token: options.token,
        })
      : [];
  const pullRequestReview =
    options.type === "pull-request" && pullRequest
      ? await pullRequestReviewFiles({
          client: options.client,
          name: repo,
          owner,
          pullNumber: options.issueNumber,
          pullRequest,
          review: options.review,
          reviews,
          token: options.token,
        })
      : { files: [] };
  const timeline = pullRequestTimeline({
    comments,
    issue,
    issueNumber: options.issueNumber,
    relatedTimeline,
    reviewComments: reviewContext.comments,
    reviews: reviewBodiesForContext(reviews, pullRequestReview.scope),
  });

  return {
    artifact: {
      body: issue.body || "",
      createdAt: issue.created_at,
      labels: labelNames(issue.labels),
      number: String(issue.number || options.issueNumber),
      title: issue.title || "",
      type: options.type || "issue",
      updatedAt: issue.updated_at,
      url: issue.html_url || "",
      pullRequestHead: pullRequestHead(pullRequest),
    },
    generatedAt: new Date().toISOString(),
    pullRequestFiles: pullRequestReview.files.length ? pullRequestReview.files : undefined,
    repository: options.repository,
    resolvedReviewFindingIds:
      options.type === "pull-request" ? reviewContext.resolvedFindingIds : undefined,
    reviewScope: pullRequestReview.scope,
    timeline,
  };
}

function pullRequestTimeline(options: {
  comments: CommentResponse[];
  issue: IssueResponse;
  issueNumber: string;
  relatedTimeline: TimelineItem[];
  reviewComments: PullRequestReviewCommentNode[];
  reviews: PullRequestReviewResponse[];
}): TimelineItem[] {
  return [
    toTimelineItem("body", `issue-${options.issueNumber}`, options.issue),
    ...options.comments.map((comment) =>
      toTimelineItem("comment", String(comment.id || ""), comment),
    ),
    ...options.reviews.map(toPullRequestReviewBodyTimelineItem),
    ...options.reviewComments.map(toPullRequestReviewTimelineItem),
    ...options.relatedTimeline,
  ].sort(compareTimelineItems);
}

function reviewBodiesForContext(
  reviews: PullRequestReviewResponse[],
  scope: ContextPacket["reviewScope"],
): PullRequestReviewResponse[] {
  const cutoff = scope?.checkpointSubmittedAt;
  if (!cutoff) return reviews;
  return reviews.filter((review) => {
    if (!gitVibeReviewAuthor(review.user?.login)) return true;
    return !review.submitted_at || review.submitted_at >= cutoff;
  });
}

function gitVibeReviewAuthor(value: string | undefined): boolean {
  const login = String(value || "")
    .trim()
    .toLowerCase();
  return login === "gitvibe-for-github" || login === "gitvibe-for-github[bot]";
}

function labelNames(labels: IssueResponse["labels"]): string[] {
  return (labels || [])
    .map((label) => (typeof label === "string" ? label : label.name || ""))
    .filter(Boolean);
}

async function pullRequestDetails(options: {
  client: GitHubClient;
  issueNumber: string;
  name: string;
  owner: string;
  token: string;
}): Promise<PullRequestResponse> {
  return options.client.request<PullRequestResponse>({
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/pulls/${options.issueNumber}`,
    token: options.token,
  });
}

function pullRequestHead(
  pullRequest: PullRequestResponse | undefined,
): ContextPacket["artifact"]["pullRequestHead"] {
  const branch = pullRequest?.head?.ref || "";
  const repository =
    pullRequest?.head?.repo?.full_name ||
    (pullRequest?.head?.repo?.owner?.login && pullRequest.head.repo.name
      ? `${pullRequest.head.repo.owner.login}/${pullRequest.head.repo.name}`
      : "");
  if (!branch || !repository) return undefined;
  return { branch, repository, sha: pullRequest?.head?.sha };
}

async function pullRequestRelatedTimeline(options: {
  client: GitHubClient;
  issue: IssueResponse;
  name: string;
  owner: string;
  prNumber: string;
  repository: string;
  token: string;
}): Promise<TimelineItem[]> {
  const issueNumbers = gitVibeTraceabilityIssueNumbers(options.issue.body || "");
  const seen = new Set<string>([options.prNumber]);
  const timeline: TimelineItem[] = [];

  for (const issueNumber of issueNumbers) {
    if (seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    const source = await issueTimeline({
      ...options,
      issueNumber,
      role: "source-issue",
    });
    timeline.push(...source.timeline);

    const discussion = sourceDiscussionTraceFromBody(source.issue.body || "");
    if (discussion) {
      const discussionContext = await buildDiscussionContext({
        client: options.client,
        discussionNumber: discussion.number,
        repository: options.repository,
        token: options.token,
      });
      timeline.push(...relatedContextTimeline("source-discussion", discussionContext.timeline));
    }

    const relatedIssues = await relatedIssueNumbers({
      client: options.client,
      issueNumber,
      name: options.name,
      owner: options.owner,
      token: options.token,
    });
    for (const related of relatedIssues) {
      if (seen.has(related.number)) continue;
      seen.add(related.number);
      const relatedIssue = await issueTimeline({
        ...options,
        issueNumber: related.number,
        role: related.role,
      });
      timeline.push(...relatedIssue.timeline);
    }
  }

  return timeline;
}

async function issueTimeline(options: {
  client: GitHubClient;
  issueNumber: string;
  name: string;
  owner: string;
  role: "parent-issue" | "source-issue" | "sub-issue";
  token: string;
}): Promise<{ issue: IssueResponse; timeline: TimelineItem[] }> {
  const issue = await options.client.request<IssueResponse>({
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/issues/${options.issueNumber}`,
    token: options.token,
  });
  const comments = await paginatedGitHubRequest<CommentResponse>(options.client, {
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/issues/${options.issueNumber}/comments`,
    token: options.token,
  });
  return {
    issue,
    timeline: [
      relatedTimelineItem(
        options.role,
        toTimelineItem("body", `issue-${options.issueNumber}`, issue),
      ),
      ...comments.map((comment) =>
        relatedTimelineItem(
          options.role,
          toTimelineItem("comment", String(comment.id || ""), comment),
        ),
      ),
    ],
  };
}

async function relatedIssueNumbers(options: {
  client: GitHubClient;
  issueNumber: string;
  name: string;
  owner: string;
  token: string;
}): Promise<Array<{ number: string; role: "parent-issue" | "sub-issue" }>> {
  const data = await options.client.graphql<RelatedIssuesQueryResult>(
    relatedIssuesQuery,
    {
      name: options.name,
      number: Number(options.issueNumber),
      owner: options.owner,
    },
    options.token,
  );
  const issue = data.repository.issue;
  const related: Array<{ number: string; role: "parent-issue" | "sub-issue" }> = [];
  if (issue.parent?.number) {
    related.push({ number: String(issue.parent.number), role: "parent-issue" });
  }
  for (const node of issue.subIssues.nodes) {
    if (node.number) related.push({ number: String(node.number), role: "sub-issue" });
  }
  return related;
}

function relatedContextTimeline(role: string, timeline: TimelineItem[]): TimelineItem[] {
  return timeline.map((item) => relatedTimelineItem(role, item));
}

function relatedTimelineItem(role: string, item: TimelineItem): TimelineItem {
  return { ...item, id: `${role}-${item.id}`, kind: `${role}-${item.kind}` };
}

async function pullRequestReviews(options: {
  client: GitHubClient;
  name: string;
  owner: string;
  pullNumber: string;
  token: string;
}): Promise<PullRequestReviewResponse[]> {
  const reviews = await paginatedGitHubRequest<PullRequestReviewResponse>(options.client, {
    method: "GET",
    path: `/repos/${options.owner}/${options.name}/pulls/${options.pullNumber}/reviews`,
    token: options.token,
  });
  return reviews.filter((review) => Boolean(review.body?.trim()));
}

export async function buildDiscussionContext(options: {
  client: GitHubClient;
  discussionNumber: string;
  repository: string;
  token: string;
}): Promise<ContextPacket> {
  const { owner, repo } = splitRepository(options.repository);
  const {
    comments: discussionComments,
    discussion,
    labels,
  } = await discussionContext({
    client: options.client,
    discussionNumber: options.discussionNumber,
    name: repo,
    owner,
    token: options.token,
  });
  const comments = discussionComments.flatMap((comment) => [
    discussionNodeToTimelineItem("comment", comment.id, comment),
    ...(comment.replies?.nodes || []).map((reply) =>
      discussionNodeToTimelineItem("reply", reply.id, reply, comment.id),
    ),
  ]);

  return {
    artifact: {
      body: discussion.body || "",
      createdAt: discussion.createdAt,
      id: discussion.id,
      labels: labels.map((label) => label.name),
      number: options.discussionNumber,
      title: discussion.title || "",
      type: "discussion",
      updatedAt: discussion.updatedAt,
      url: discussion.url || "",
    },
    generatedAt: new Date().toISOString(),
    repository: options.repository,
    timeline: [
      discussionNodeToTimelineItem("body", `discussion-${options.discussionNumber}`, discussion),
      ...comments,
    ].sort(compareTimelineItems),
  };
}

function toTimelineItem(kind: string, id: string, item: IssueResponse): TimelineItem {
  return {
    author: item.user?.login || "<unknown>",
    authorAssociation: item.author_association,
    body: item.body || "",
    createdAt: item.created_at || "",
    id,
    kind,
    reactions: item.reactions,
    updatedAt: kind === "body" ? undefined : item.updated_at,
    url: item.html_url || "",
  };
}

function toPullRequestReviewTimelineItem(item: PullRequestReviewCommentNode): TimelineItem {
  const path = item.path ? `Path: ${item.path}\n` : "";
  const diff = item.diffHunk ? `Diff:\n${item.diffHunk}\n\n` : "";
  return {
    ...toTimelineItem("pull-request-review-comment", String(item.id || ""), {
      ...item,
      body: `${path}${diff}${item.body || ""}`,
      created_at: item.createdAt,
      html_url: item.url,
      updated_at: item.updatedAt,
      user: item.author,
    }),
    authorAssociation: item.authorAssociation,
    databaseId: item.databaseId,
    parentId: item.replyTo?.id ? String(item.replyTo.id) : undefined,
    reviewThreadId: item.reviewThreadId,
    reviewThreadIsOutdated: item.reviewThreadIsOutdated,
  };
}

function toPullRequestReviewBodyTimelineItem(item: PullRequestReviewResponse): TimelineItem {
  return {
    ...toTimelineItem("pull-request-review", String(item.node_id || item.id || ""), {
      ...item,
      body: item.body || "",
      created_at: item.submitted_at,
      html_url: item.html_url,
      updated_at: item.submitted_at,
      user: item.user,
    }),
    databaseId: item.id,
  };
}

function discussionNodeToTimelineItem(
  kind: string,
  id: string,
  item: DiscussionNode,
  parentId?: string,
): TimelineItem {
  return {
    author: item.author?.login || "<unknown>",
    body: item.body || "",
    createdAt: item.createdAt || "",
    id,
    kind,
    parentId,
    reactions: {},
    updatedAt: kind === "body" ? undefined : item.updatedAt,
    url: item.url || "",
  };
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  return left.createdAt.localeCompare(right.createdAt);
}

interface RelatedIssueNode {
  number?: number;
}

interface RelatedIssuesQueryResult {
  repository: {
    issue: {
      parent?: RelatedIssueNode | null;
      subIssues: { nodes: RelatedIssueNode[] };
    };
  };
}

const relatedIssuesQuery = `
  query GitVibeRelatedIssues($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        parent {
          number
        }
        subIssues(first: 20) {
          nodes {
            number
          }
        }
      }
    }
  }
`;
