import type { GitHubClient } from "../shared/github.js";
import { reviewFindingMarkerId } from "./review-finding-ids.js";

export interface DiscussionNode {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
  id: string;
  labels?: GraphQLConnection<{ name: string }>;
  replies?: GraphQLConnection<DiscussionNode>;
  title?: string;
  updatedAt?: string;
  url?: string;
}

export interface PullRequestReviewCommentNode {
  author?: { login?: string };
  authorAssociation?: string;
  body?: string;
  createdAt?: string;
  databaseId?: number;
  diffHunk?: string;
  id: string;
  path?: string;
  replyTo?: { id?: string } | null;
  reviewThreadId?: string;
  reviewThreadIsOutdated?: boolean;
  updatedAt?: string;
  url?: string;
}

interface GraphQLConnection<T> {
  nodes: T[];
  pageInfo?: {
    endCursor?: string | null;
    hasNextPage?: boolean;
  };
}

interface PullRequestReviewThreadNode {
  comments: GraphQLConnection<PullRequestReviewCommentNode>;
  id: string;
  isOutdated: boolean;
  isResolved: boolean;
  path: string;
}

interface DiscussionQueryResult {
  repository: {
    discussion: DiscussionNode & {
      comments: GraphQLConnection<DiscussionNode>;
    };
  };
}

interface DiscussionNodeResult {
  node?: {
    comments?: GraphQLConnection<DiscussionNode>;
    labels?: GraphQLConnection<{ name: string }>;
    replies?: GraphQLConnection<DiscussionNode>;
  } | null;
}

interface PullRequestReviewThreadsQueryResult {
  repository: {
    pullRequest: {
      reviewThreads: GraphQLConnection<PullRequestReviewThreadNode>;
    };
  };
}

interface PullRequestReviewThreadResult {
  node?: {
    comments?: GraphQLConnection<PullRequestReviewCommentNode>;
  } | null;
}

export interface PullRequestReviewContext {
  comments: PullRequestReviewCommentNode[];
  resolvedFindingIds: string[];
}

export async function discussionContext(options: {
  client: GitHubClient;
  discussionNumber: string;
  name: string;
  owner: string;
  token: string;
}): Promise<{
  comments: DiscussionNode[];
  discussion: DiscussionNode;
  labels: Array<{ name: string }>;
}> {
  const data = await options.client.graphql<DiscussionQueryResult>(
    discussionQuery,
    { name: options.name, number: Number(options.discussionNumber), owner: options.owner },
    options.token,
  );
  const discussion = data.repository.discussion;
  const labels = await discussionLabelsPage({
    client: options.client,
    discussionId: discussion.id,
    initial: discussion.labels,
    token: options.token,
  });
  const comments = await discussionCommentsPage({
    client: options.client,
    discussionId: discussion.id,
    initial: discussion.comments,
    token: options.token,
  });
  return { comments, discussion, labels };
}

export async function pullRequestReviewContext(options: {
  client: GitHubClient;
  name: string;
  owner: string;
  pullNumber: string;
  token: string;
}): Promise<PullRequestReviewContext> {
  const data = await options.client.graphql<PullRequestReviewThreadsQueryResult>(
    pullRequestReviewThreadsQuery,
    {
      after: null,
      name: options.name,
      number: Number(options.pullNumber),
      owner: options.owner,
    },
    options.token,
  );
  const threads = await pullRequestReviewThreadsPage({
    client: options.client,
    initial: data.repository.pullRequest.reviewThreads,
    name: options.name,
    owner: options.owner,
    pullNumber: options.pullNumber,
    token: options.token,
  });
  return {
    comments: threads.filter((thread) => !thread.isResolved).flatMap(reviewThreadComments),
    resolvedFindingIds: resolvedReviewFindingIds(threads),
  };
}

function reviewThreadComments(thread: PullRequestReviewThreadNode): PullRequestReviewCommentNode[] {
  return thread.comments.nodes.map((comment) => ({
    ...comment,
    path: comment.path || thread.path,
    reviewThreadId: thread.id,
    reviewThreadIsOutdated: thread.isOutdated,
  }));
}

function resolvedReviewFindingIds(threads: PullRequestReviewThreadNode[]): string[] {
  const ids = threads.flatMap((thread) => {
    if (!thread.isResolved) return [];
    return thread.comments.nodes.flatMap((comment) => {
      if (comment.replyTo?.id || !gitVibeReviewAuthor(comment.author?.login)) return [];
      const id = reviewFindingMarkerId(comment.body || "");
      return id ? [id] : [];
    });
  });
  return [...new Set(ids)].sort();
}

function gitVibeReviewAuthor(value: string | undefined): boolean {
  const login = String(value || "")
    .trim()
    .toLowerCase();
  return login === "gitvibe-for-github" || login === "gitvibe-for-github[bot]";
}

async function discussionCommentsPage(options: {
  client: GitHubClient;
  discussionId: string;
  initial: GraphQLConnection<DiscussionNode>;
  token: string;
}): Promise<DiscussionNode[]> {
  const comments: DiscussionNode[] = [];
  let connection: GraphQLConnection<DiscussionNode> | undefined = options.initial;
  while (connection) {
    for (const comment of connection.nodes) {
      comments.push({
        ...comment,
        replies: { nodes: await discussionRepliesPage(options.client, options.token, comment) },
      });
    }
    const after: string | null = nextPageCursor(connection);
    if (!after) break;
    const result: DiscussionNodeResult = await options.client.graphql<DiscussionNodeResult>(
      discussionCommentsPageQuery,
      { after, discussionId: options.discussionId },
      options.token,
    );
    connection = result.node?.comments;
  }
  return comments;
}

async function discussionRepliesPage(
  client: GitHubClient,
  token: string,
  comment: DiscussionNode,
): Promise<DiscussionNode[]> {
  const replies = [...(comment.replies?.nodes || [])];
  let after = nextPageCursor(comment.replies);
  while (after) {
    const result = await client.graphql<DiscussionNodeResult>(
      discussionRepliesPageQuery,
      { after, commentId: comment.id },
      token,
    );
    const connection = result.node?.replies;
    replies.push(...(connection?.nodes || []));
    after = nextPageCursor(connection);
  }
  return replies;
}

async function discussionLabelsPage(options: {
  client: GitHubClient;
  discussionId: string;
  initial?: GraphQLConnection<{ name: string }>;
  token: string;
}): Promise<Array<{ name: string }>> {
  const labels = [...(options.initial?.nodes || [])];
  let after = nextPageCursor(options.initial);
  while (after) {
    const result = await options.client.graphql<DiscussionNodeResult>(
      discussionLabelsPageQuery,
      { after, discussionId: options.discussionId },
      options.token,
    );
    const connection = result.node?.labels;
    labels.push(...(connection?.nodes || []));
    after = nextPageCursor(connection);
  }
  return labels;
}

async function pullRequestReviewThreadsPage(options: {
  client: GitHubClient;
  initial: GraphQLConnection<PullRequestReviewThreadNode>;
  name: string;
  owner: string;
  pullNumber: string;
  token: string;
}): Promise<PullRequestReviewThreadNode[]> {
  const threads: PullRequestReviewThreadNode[] = [];
  let connection: GraphQLConnection<PullRequestReviewThreadNode> | undefined = options.initial;
  while (connection) {
    for (const thread of connection.nodes) {
      threads.push({
        ...thread,
        comments: {
          nodes: await pullRequestReviewThreadCommentsPage(options.client, options.token, thread),
        },
      });
    }
    const after: string | null = nextPageCursor(connection);
    if (!after) break;
    const data: PullRequestReviewThreadsQueryResult =
      await options.client.graphql<PullRequestReviewThreadsQueryResult>(
        pullRequestReviewThreadsQuery,
        {
          after,
          name: options.name,
          number: Number(options.pullNumber),
          owner: options.owner,
        },
        options.token,
      );
    connection = data.repository.pullRequest.reviewThreads;
  }
  return threads;
}

async function pullRequestReviewThreadCommentsPage(
  client: GitHubClient,
  token: string,
  thread: PullRequestReviewThreadNode,
): Promise<PullRequestReviewCommentNode[]> {
  const comments = [...(thread.comments.nodes || [])];
  let after = nextPageCursor(thread.comments);
  while (after) {
    const result = await client.graphql<PullRequestReviewThreadResult>(
      pullRequestReviewThreadCommentsQuery,
      { after, threadId: thread.id },
      token,
    );
    const connection = result.node?.comments;
    comments.push(...(connection?.nodes || []));
    after = nextPageCursor(connection);
  }
  return comments;
}

function nextPageCursor<T>(connection: GraphQLConnection<T> | undefined): string | null {
  return connection?.pageInfo?.hasNextPage && connection.pageInfo.endCursor
    ? connection.pageInfo.endCursor
    : null;
}

const discussionQuery = `
  query GitVibeDiscussion($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      discussion(number: $number) {
        id
        title
        body
        createdAt
        updatedAt
        url
        author { login }
        labels(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            name
          }
        }
        comments(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            body
            createdAt
            updatedAt
            url
            author { login }
            replies(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                databaseId
                body
                createdAt
                updatedAt
                url
                author { login }
                replies(first: 0) { nodes { id } }
              }
            }
          }
        }
      }
    }
  }
`;

const discussionCommentsPageQuery = `
  query GitVibeDiscussionCommentsPage($discussionId: ID!, $after: String) {
    node(id: $discussionId) {
      ... on Discussion {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            body
            createdAt
            updatedAt
            url
            author { login }
            replies(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                databaseId
                body
                createdAt
                updatedAt
                url
                author { login }
                replies(first: 0) { nodes { id } }
              }
            }
          }
        }
      }
    }
  }
`;

const discussionRepliesPageQuery = `
  query GitVibeDiscussionRepliesPage($commentId: ID!, $after: String) {
    node(id: $commentId) {
      ... on DiscussionComment {
        replies(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            body
            createdAt
            updatedAt
            url
            author { login }
            replies(first: 0) { nodes { id } }
          }
        }
      }
    }
  }
`;

const discussionLabelsPageQuery = `
  query GitVibeDiscussionLabelsPage($discussionId: ID!, $after: String) {
    node(id: $discussionId) {
      ... on Discussion {
        labels(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  }
`;

const pullRequestReviewThreadsQuery = `
  query GitVibePullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isOutdated
            isResolved
            path
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                databaseId
                body
                createdAt
                updatedAt
                url
                authorAssociation
                diffHunk
                path
                author { login }
                replyTo { id }
              }
            }
          }
        }
      }
    }
  }
`;

const pullRequestReviewThreadCommentsQuery = `
  query GitVibePullRequestReviewThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            body
            createdAt
            updatedAt
            url
            authorAssociation
            diffHunk
            path
            author { login }
            replyTo { id }
          }
        }
      }
    }
  }
`;
