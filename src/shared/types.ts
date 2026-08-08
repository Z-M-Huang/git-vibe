export type Stage = "investigate" | "validate" | "materialize" | "review-matrix";

export type JsonObject = Record<string, unknown>;
export type SourceCommentKind =
  | "discussion-comment"
  | "issue-comment"
  | "pull-request-comment"
  | "pull-request-review"
  | "pull-request-review-comment";

export interface ReviewRunState {
  baseSha?: string;
  checkpointSha?: string;
  inputSafetyDigest?: string;
  snapshotSha?: string;
  targetSha?: string;
}

export interface ReviewScope {
  baseSha: string;
  checkpointSha?: string;
  checkpointSubmittedAt?: string;
  headRepository: string;
  snapshotSha: string;
  targetSha: string;
}

export interface StageDefinition {
  promptDir: string;
  schemaFile: string;
  schemaId: string;
  target: "issue" | "discussion" | "pull-request";
  tools: string[];
}

export interface RunnerOptions {
  acceptedRisk?: {
    actor?: string;
    artifactContentSha?: string;
    artifactSha?: string;
    cutoff: string;
    run?: string;
    runAttempt?: string;
    stages: Stage[];
  };
  cwd: string;
  dryRun: boolean;
  executionMode?: "finalizer" | "member" | "standard";
  failOnNotReady?: boolean;
  handoffDir?: string;
  issueNumber: string;
  memberResultsDir?: string;
  maxTurns: number;
  prNumber: string;
  profileName?: string;
  repository: string;
  review?: ReviewRunState;
  roleName?: string;
  sourceComment?: SourceComment;
  stage: Stage;
  stageTimeoutMinutes: number;
  token: string;
  workflowRunAttempt?: string;
  workflowRunUrl?: string;
}

export interface GitVibeConfig {
  ai?: JsonObject;
  safety?: {
    block_write_stages_on_high_risk?: boolean;
    ignored_authors?: string[];
    prompt_injection_gate?: boolean;
    remove_approval_on_block?: boolean;
  };
  tests?: {
    commands?: string[];
  };
}

export interface TimelineItem {
  author: string;
  authorAssociation?: string;
  body: string;
  createdAt: string;
  databaseId?: number | string;
  id: string;
  kind: string;
  parentId?: string;
  reactions?: JsonObject;
  reviewThreadId?: string;
  reviewThreadIsOutdated?: boolean;
  updatedAt?: string;
  url: string;
}

export interface StageHandoff {
  commentBody?: string;
  createdAt?: string;
  parsedOutput: JsonObject;
  schemaId: string;
  source?: {
    author?: string;
    bodySha?: string;
    databaseId?: number | string;
    id?: string;
    kind?: string;
    sourceUrl?: string;
  };
  stage: Stage;
  status: string;
  summary: string;
  updatedAt?: string;
}

export interface SourceComment {
  body?: string;
  id?: string;
  kind: SourceCommentKind;
  nodeId?: string;
  url?: string;
}

export interface PullRequestFile {
  additions?: number;
  blobUrl?: string;
  changes?: number;
  contentsUrl?: string;
  deletions?: number;
  filename: string;
  patch?: string;
  previousFilename?: string;
  rawUrl?: string;
  status: string;
}

export interface ContextPacket {
  artifact: {
    body: string;
    id?: string;
    labels?: string[];
    number: string;
    title: string;
    type: "issue" | "discussion" | "pull-request";
    url: string;
    createdAt?: string;
    pullRequestHead?: {
      branch: string;
      repository: string;
      sha?: string;
    };
    updatedAt?: string;
  };
  generatedAt: string;
  handoffs?: StageHandoff[];
  pullRequestFiles?: PullRequestFile[];
  resolvedReviewFindingIds?: string[];
  reviewScope?: ReviewScope;
  repository: string;
  source?: {
    comment?: SourceComment;
  };
  timeline: TimelineItem[];
}

export interface StageRunResult {
  commentBody: string;
  parsedOutput: JsonObject;
  resultFile?: string;
  schemaId: string;
  status: string;
  summary: string;
  validationErrors: string[];
}
