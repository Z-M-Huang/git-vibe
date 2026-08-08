import { createHash } from "node:crypto";
import type { ContextPacket, GitVibeConfig, JsonObject, RunnerOptions } from "../shared/types.js";
import { contentUnitsForContext, type ContentUnit } from "./content-units.js";

export type SafetySeverity = "none" | "low" | "medium" | "high";

export interface SafetyGateResult {
  allowed: boolean;
  blockedReason?: string;
  findings: string[];
  severity: SafetySeverity;
}

export interface SafetySource {
  label: string;
  text: string;
}

export function promptInjectionGateEnabled(config: GitVibeConfig): boolean {
  return config.safety?.prompt_injection_gate !== false;
}

export function removeApprovalOnSafetyBlock(config: GitVibeConfig): boolean {
  return config.safety?.remove_approval_on_block !== false;
}

export function safetyGateSources(options: {
  context: ContextPacket;
  contextUnits?: ContentUnit[];
  extraSources?: SafetySource[];
  ignoredAuthors?: readonly string[];
  includeContext: boolean;
  output?: JsonObject;
}): ContentUnit[] {
  const contextUnits = options.includeContext
    ? safetyContextUnits({
        context: options.context,
        contextUnits: options.contextUnits,
        ignoredAuthors: options.ignoredAuthors,
      })
    : [];
  return [
    ...(options.includeContext ? contextUnits : []),
    ...(options.output
      ? [
          safetySourceUnit(
            { label: "stage output", text: JSON.stringify(options.output) },
            "stage-output",
          ),
        ]
      : []),
    ...(options.extraSources || []).map((source, index) =>
      safetySourceUnit(source, `extra-source-${index}`),
    ),
  ].filter((source) => source.text.trim());
}

export function safetyContextDigest(options: {
  context: ContextPacket;
  ignoredAuthors?: readonly string[];
}): string {
  const sources = safetyContextUnits({
    context: options.context,
    ignoredAuthors: options.ignoredAuthors,
  });
  return createHash("sha256")
    .update(
      JSON.stringify(
        sources.map((source) => ({ id: source.id, label: source.label, text: source.text })),
      ),
    )
    .digest("hex");
}

function sanitizedSafetyContextUnits(units: ContentUnit[]): ContentUnit[] {
  return units.map((item) =>
    gitVibeOwnedPriorSafetyResultUnit(item)
      ? { ...item, text: gitVibePriorSafetyResultPlaceholder(item) }
      : item,
  );
}

function safetyContextUnits(options: {
  context: ContextPacket;
  contextUnits?: ContentUnit[];
  ignoredAuthors?: readonly string[];
}): ContentUnit[] {
  return sanitizedSafetyContextUnits(
    options.contextUnits ??
      contentUnitsForContext(options.context, { ignoredAuthors: options.ignoredAuthors }),
  );
}

function gitVibeOwnedPriorSafetyResultUnit(unit: ContentUnit): boolean {
  if (!priorGitVibeSafetyResultText(unit.text)) return false;
  if (unit.kind === "timeline") return gitVibeAutomationAuthor(unit.metadata?.author);
  if (unit.kind === "handoff") return gitVibeAutomationAuthor(unit.metadata?.sourceAuthor);
  return false;
}

function priorGitVibeSafetyResultText(text: string): boolean {
  if (gitVibeAcceptedRiskText(text)) return true;
  return (
    text.includes("GitVibe paused this run for maintainer review.") &&
    (text.includes("prompt-injection") ||
      text.includes("git-vibe:accept-risk") ||
      /"next_state"\s*:\s*"blocked"/.test(text) ||
      /"status"\s*:\s*"blocked"/.test(text))
  );
}

function gitVibeAcceptedRiskText(text: string): boolean {
  return (
    gitVibeAcceptedRiskMetadataPattern.test(text) || /^## GitVibe Risk Accepted\s*$/m.test(text)
  );
}

function gitVibeAutomationAuthor(value: unknown): boolean {
  return gitVibeAutomationAuthors.has(stringMetadata(value).toLowerCase());
}

function gitVibePriorSafetyResultPlaceholder(unit: ContentUnit): string {
  const stage = stringMetadata(unit.metadata?.stage);
  return [
    "[GitVibe-owned prior prompt-injection safety result omitted from input safety scan.]",
    stage ? `stage: ${stage}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function stringMetadata(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const gitVibeAcceptedRiskMetadataPattern = new RegExp(
  String.raw`<!--\s*git-vibe:accepted-risk-metadata\b`,
  "i",
);
const gitVibeAutomationAuthors = new Set(["gitvibe-for-github", "gitvibe-for-github[bot]"]);

export function allowedSafetyGateResult(): SafetyGateResult {
  return { allowed: true, findings: [], severity: "none" };
}

export function blockedSafetyGateResult(options: {
  findings: string[];
  reason?: string;
  severity?: Exclude<SafetySeverity, "none">;
}): SafetyGateResult {
  return {
    allowed: false,
    blockedReason:
      options.reason ||
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
    findings: options.findings,
    severity: options.severity || "high",
  };
}

export function safetyBlockedOutput(options: {
  context: ContextPacket;
  gate: SafetyGateResult;
  runner: RunnerOptions;
}): JsonObject {
  const summary = "GitVibe paused this run for maintainer review.";
  const guidance = safetyBlockedGuidance(options.gate);
  const question = {
    options: [guidance],
    question:
      options.gate.blockedReason ||
      "GitVibe detected high-risk prompt-injection content in untrusted input.",
  };
  const base = {
    assumptions: [],
    comment_body: safetyBlockedComment(options.gate),
    findings: options.gate.findings,
    next_state: "blocked",
    questions: [question],
    references: [options.context.artifact.url, options.runner.workflowRunUrl].filter(
      (value): value is string => Boolean(value),
    ),
    stage: options.runner.stage,
    status: "blocked",
    summary,
  };

  if (options.runner.stage === "investigate") {
    return { ...base, blocking_questions: [question], implementation_plan: [] };
  }
  if (options.runner.stage === "materialize") return { ...base, issues: [] };
  if (options.runner.stage === "review-matrix") {
    return { ...base, inline_comments: [], tests: [] };
  }
  return base;
}

function safetySourceUnit(source: SafetySource, id: string): ContentUnit {
  return {
    id,
    kind: "safety-source",
    label: source.label,
    text: source.text,
  };
}

function safetyBlockedComment(gate: SafetyGateResult): string {
  return [
    gate.blockedReason ||
      "High-risk prompt-injection content was detected before GitVibe could safely continue.",
    "",
    safetyBlockedCommentGuidance(gate),
    "",
    "Detected risk:",
    ...gate.findings.map((finding) => `- ${finding}`),
  ].join("\n");
}

function safetyBlockedGuidance(gate: SafetyGateResult): string {
  if (isSafetyClassifierFailure(gate)) {
    return "Rerun after the safety classifier runtime is healthy, or fix the safety configuration before rerunning.";
  }
  return "Change the flagged content or safety configuration, or apply `git-vibe:accept-risk` to accept this prompt-injection input risk for matching context.";
}

function safetyBlockedCommentGuidance(gate: SafetyGateResult): string {
  if (isSafetyClassifierFailure(gate)) {
    return "GitVibe could not complete the prompt-injection safety classifier, so it failed closed. A trusted maintainer must rerun after the classifier runtime is healthy, fix the safety configuration, or handle the case manually before automation continues.";
  }
  return "GitVibe treats issue bodies, comments, diffs, repository files, and future image/OCR text as untrusted data. A trusted maintainer must change the flagged content, adjust safety configuration, apply `git-vibe:accept-risk` for matching context, or handle the case manually before automation continues.";
}

function isSafetyClassifierFailure(gate: SafetyGateResult): boolean {
  return gate.findings.some((finding) => finding.startsWith("safety gate: AI safety gate failed"));
}
