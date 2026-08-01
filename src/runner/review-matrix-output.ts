import { createHash } from "node:crypto";
import {
  effectiveReviewFindingId,
  reviewFindingMarkerId,
  visibleReviewCommentBody,
} from "./review-finding-ids.js";
import type { ContextPacket, JsonObject } from "../shared/types.js";

interface IndexedInlineComment {
  findingId: string;
  index: number;
  item: JsonObject;
  stableKey: string;
}

export interface ReviewMatrixOutputNormalization {
  carriedFindings: number;
  duplicateFindingIds: number;
  output: JsonObject;
  rewrittenInlineComments: number;
}

export function normalizeReviewMatrixOutput(
  output: JsonObject,
  context?: ContextPacket,
): ReviewMatrixOutputNormalization {
  return carryIncrementalFindings(normalizeDuplicateFindingIds(output), context);
}

function normalizeDuplicateFindingIds(output: JsonObject): ReviewMatrixOutputNormalization {
  if (!Array.isArray(output.inline_comments)) return unchangedOutput(output);
  const comments = output.inline_comments;
  const groups = groupedInlineComments(comments);
  const duplicateGroups = [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .sort(([left], [right]) => compareStrings(left, right));
  if (!duplicateGroups.length) return unchangedOutput(output);

  const normalized = [...comments];
  const occupiedIds = new Set(groups.keys());
  let rewrittenInlineComments = 0;
  for (const [findingId, entries] of duplicateGroups) {
    const sorted = [...entries].sort(compareInlineComments);
    const occurrences = new Map<string, number>();
    for (const [position, entry] of sorted.entries()) {
      const occurrence = occurrences.get(entry.stableKey) || 0;
      occurrences.set(entry.stableKey, occurrence + 1);
      const assignedId =
        position === 0
          ? findingId
          : collisionFindingId({
              findingId,
              occurrence,
              occupiedIds,
              stableKey: entry.stableKey,
            });
      occupiedIds.add(assignedId);
      if (entry.item.finding_id !== assignedId) rewrittenInlineComments += 1;
      normalized[entry.index] = { ...entry.item, finding_id: assignedId };
    }
  }
  return {
    carriedFindings: 0,
    duplicateFindingIds: duplicateGroups.length,
    output: { ...output, inline_comments: normalized },
    rewrittenInlineComments,
  };
}

function carryIncrementalFindings(
  normalization: ReviewMatrixOutputNormalization,
  context: ContextPacket | undefined,
): ReviewMatrixOutputNormalization {
  if (!context?.reviewScope?.checkpointSha) return normalization;
  if (stringValue(normalization.output.status) !== "completed") return normalization;
  const prior = priorFindingItems(context);
  const current = currentFindingIds(normalization.output);
  const resolved = new Set(stringItems(normalization.output.resolved_finding_ids));
  for (const id of resolved) {
    if (!prior.has(id)) throw new Error(`resolved_finding_ids contains unknown finding: ${id}.`);
    if (current.has(id)) throw new Error(`Finding ${id} cannot be current and resolved.`);
  }
  const carried = [...prior.values()].filter(
    (finding) => !current.has(finding.id) && !resolved.has(finding.id),
  );
  if (!carried.length) return normalization;
  return {
    ...normalization,
    carriedFindings: carried.length,
    output: {
      ...normalization.output,
      findings: [...stringItems(normalization.output.findings), ...carried.map(carriedFindingText)],
      next_state: "changes-required",
    },
  };
}

function priorFindingItems(
  context: ContextPacket,
): Map<string, { body: string; id: string; url: string }> {
  const findings = new Map<string, { body: string; id: string; url: string }>();
  for (const item of context.timeline) {
    if (item.kind !== "pull-request-review-comment" || item.parentId) continue;
    if (!gitVibeReviewAuthor(item.author)) continue;
    const id = reviewFindingMarkerId(item.body);
    if (id) findings.set(id, { body: visibleReviewCommentBody(item.body), id, url: item.url });
  }
  return findings;
}

function currentFindingIds(output: JsonObject): Set<string> {
  if (!Array.isArray(output.inline_comments)) return new Set();
  return new Set(
    output.inline_comments.flatMap((value) => {
      const item = recordValue(value);
      const id = item ? stringValue(item.finding_id) : "";
      return id ? [id] : [];
    }),
  );
}

function carriedFindingText(finding: { body: string; id: string; url: string }): string {
  const detail = finding.body.replace(/\s+/g, " ").trim().slice(0, 300);
  return `Existing unresolved GitVibe finding ${finding.id}${detail ? `: ${detail}` : ""}${finding.url ? ` (${finding.url})` : ""}`;
}

function gitVibeReviewAuthor(value: string): boolean {
  const login = value.trim().toLowerCase();
  return login === "gitvibe-for-github" || login === "gitvibe-for-github[bot]";
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function groupedInlineComments(comments: unknown[]): Map<string, IndexedInlineComment[]> {
  const groups = new Map<string, IndexedInlineComment[]>();
  for (const [index, value] of comments.entries()) {
    const item = recordValue(value);
    const indexed = item ? indexedInlineComment(item, index) : undefined;
    if (!indexed) continue;
    const entries = groups.get(indexed.findingId) || [];
    entries.push(indexed);
    groups.set(indexed.findingId, entries);
  }
  return groups;
}

function indexedInlineComment(item: JsonObject, index: number): IndexedInlineComment | undefined {
  const rawBody = stringValue(item.body);
  const body = visibleReviewCommentBody(rawBody);
  const line = positiveInteger(item.line);
  const path = stringValue(item.path);
  if (!body || !line || !path) return undefined;
  const startLine = positiveInteger(item.start_line);
  return {
    findingId: effectiveReviewFindingId({
      body,
      explicitFindingId: item.finding_id,
      line,
      path,
      rawBody,
      startLine,
    }),
    index,
    item,
    stableKey: [path, startLine || "", line, sideValue(item.side), body, stringValue(item.severity)]
      .map(String)
      .join("\0"),
  };
}

function collisionFindingId(options: {
  findingId: string;
  occurrence: number;
  occupiedIds: Set<string>;
  stableKey: string;
}): string {
  for (let attempt = 0; attempt <= options.occupiedIds.size; attempt += 1) {
    const digest = createHash("sha256")
      .update(
        [options.findingId, options.stableKey, options.occurrence, attempt].map(String).join("\0"),
      )
      .digest("hex")
      .slice(0, 16);
    const suffix = `:${digest}`;
    const candidate = `${options.findingId.slice(0, 80 - suffix.length)}${suffix}`;
    if (!options.occupiedIds.has(candidate)) return candidate;
  }
  throw new Error(`Unable to disambiguate review finding_id: ${options.findingId}.`);
}

function compareInlineComments(left: IndexedInlineComment, right: IndexedInlineComment): number {
  return compareStrings(left.stableKey, right.stableKey) || left.index - right.index;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unchangedOutput(output: JsonObject): ReviewMatrixOutputNormalization {
  return { carriedFindings: 0, duplicateFindingIds: 0, output, rewrittenInlineComments: 0 };
}

function recordValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sideValue(value: unknown): "LEFT" | "RIGHT" {
  return value === "LEFT" ? "LEFT" : "RIGHT";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
