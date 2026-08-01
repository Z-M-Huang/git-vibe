import type { ContextPacket, JsonObject, Stage } from "../shared/types.js";
import { reviewCheckpointVersion } from "../shared/stage-result-markers.js";
import { stageStartMarker, workflowRunIdFromUrl } from "../shared/status-comments.js";

export interface StageResultLink {
  label: string;
  url: string;
}

export interface StageResultCommentOptions {
  context: ContextPacket;
  links?: StageResultLink[];
  parsedOutput: JsonObject;
  stage: Stage;
  workflowRunUrl?: string;
}

const stageTitles: Record<Stage, string> = {
  investigate: "Investigation",
  materialize: "Implementation Issues",
  "review-matrix": "Review Matrix",
  validate: "Validation",
};

interface NormalizedQuestion {
  blocking: boolean;
  options: string[];
  question: string;
}

export function renderStageStartComment(options: {
  context: ContextPacket;
  stage: Stage;
  workflowRunUrl?: string;
}): string {
  const artifact = options.context.artifact;
  const lines = [
    stageStartMarker({
      artifact: artifact.type,
      number: artifact.number,
      run: workflowRunIdFromUrl(options.workflowRunUrl),
      stage: options.stage,
    }),
    `## GitVibe ${stageTitle(options)} Running`,
    "",
    `GitVibe is running the ${inlineCode(options.stage)} stage for ${artifact.type} #${artifact.number}.`,
    "",
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ];
  return cleanLines(lines).join("\n");
}

export function renderStageResultComment(options: StageResultCommentOptions): string {
  const output = options.parsedOutput;
  const questions = normalizedQuestions(output);
  const lines = [
    resultMarker(options),
    `## GitVibe ${stageTitle(options)}`,
    "",
    `**Status:** ${inlineCode(textField(output.status) || "completed")}`,
    stateLine(output),
    "",
    textField(output.summary) || "No summary provided.",
    ...questionsSection(questions),
    ...compactNextActionSection(output, questions.length > 0),
    ...resultSection(options),
  ];

  return cleanLines(lines).join("\n");
}

function resultMarker(options: StageResultCommentOptions): string {
  const artifact = options.context.artifact;
  const run = workflowRunIdFromUrl(options.workflowRunUrl);
  const runAttribute = run ? ` run=${run}` : "";
  const reviewScope = options.stage === "review-matrix" ? options.context.reviewScope : undefined;
  const reviewAttributes = reviewScope
    ? ` review-version=${reviewCheckpointVersion} base-sha=${reviewScope.baseSha} head-sha=${reviewScope.targetSha} snapshot-sha=${reviewScope.snapshotSha}`
    : "";
  return `<!-- git-vibe:stage-result stage=${options.stage} artifact=${artifact.type} number=${artifact.number}${runAttribute}${reviewAttributes} -->`;
}

function stageTitle(options: Pick<StageResultCommentOptions, "context" | "stage">): string {
  if (options.stage === "investigate" && options.context.artifact.type === "pull-request") {
    return "PR Feedback Investigation";
  }
  return stageTitles[options.stage];
}

function stateLine(output: JsonObject): string {
  const nextState = textField(output.next_state);
  return nextState ? `**Next state:** ${inlineCode(nextState)}` : "";
}

function questionsSection(questions: NormalizedQuestion[]): string[] {
  if (!questions.length) return [];
  return ["", "### Questions", ...questions.flatMap(questionLines)];
}

function questionLines(question: NormalizedQuestion, index: number): string[] {
  const prefix = question.blocking ? "[Blocking] " : "";
  const options = question.options.slice(0, 4);
  return [
    `${index + 1}. ${prefix}${question.question}`,
    ...options.map((option, optionIndex) => `   ${optionLetter(optionIndex)}. ${option}`),
  ];
}

function compactNextActionSection(output: JsonObject, hasQuestions: boolean): string[] {
  if (hasQuestions) {
    return [
      "",
      "### Next Action",
      "Reply in one comment with question numbers and option letters, or write your own answer for any question.",
    ];
  }
  const nextState = textField(output.next_state);
  if (!nextState || nextState === "blocked") return [];
  return ["", "### Next Action", `Continue with ${inlineCode(nextState)}.`];
}

function resultSection(options: StageResultCommentOptions): string[] {
  const references = [
    resultDetailReference(options),
    ...linkReferences(options.links || []),
    options.workflowRunUrl ? `Workflow run: ${options.workflowRunUrl}` : "",
  ].filter(Boolean);
  return ["", "### Result", ...references];
}

function resultDetailReference(options: StageResultCommentOptions): string {
  if (options.stage === "review-matrix" && options.context.artifact.type === "pull-request") {
    return "When present, required fixes are posted as pull request review comments. Full structured output remains in the workflow run summary.";
  }
  return "Full details are in the workflow run summary.";
}

function normalizedQuestions(output: JsonObject): NormalizedQuestion[] {
  return [
    ...questionItems(output.blocking_questions, true),
    ...questionItems(output.questions, false),
  ];
}

function questionItems(value: unknown, blocking: boolean): NormalizedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeQuestion(item, blocking))
    .filter((item): item is NormalizedQuestion => item !== undefined);
}

function normalizeQuestion(item: unknown, blocking: boolean): NormalizedQuestion | undefined {
  if (typeof item === "string") {
    const question = item.trim();
    return question ? { blocking, options: [], question } : undefined;
  }
  if (!item || typeof item !== "object") return undefined;
  const fields = item as Record<string, unknown>;
  const question = textField(fields.question);
  if (!question) return undefined;
  return { blocking, options: stringItems(fields.options).slice(0, 4), question };
}

function linkReferences(links: StageResultLink[]): string[] {
  return links.filter((link) => link.url).map((link) => `${link.label}: ${link.url}`);
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
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
