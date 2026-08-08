import { createHash } from "node:crypto";
import {
  acceptedRiskArtifactContentSha,
  acceptedRiskMetadataBodySha,
  parseAcceptedRiskMetadata,
  type AcceptedRiskMetadata,
  type AcceptedRiskMetadataSource,
} from "../shared/accepted-risk.js";
import type { ContextPacket, JsonObject, PullRequestFile, TimelineItem } from "../shared/types.js";
import { contextWithoutIgnoredAuthors } from "./ignored-authors.js";

export interface ContentUnit {
  id: string;
  kind: string;
  label: string;
  metadata?: JsonObject;
  path?: string;
  sourceUrl?: string;
  text: string;
}

export interface ContentChunk {
  charEnd: number;
  charStart: number;
  id: string;
  index: number;
  kind: string;
  label: string;
  metadata?: JsonObject;
  path?: string;
  sha256: string;
  sourceUrl?: string;
  text: string;
  total: number;
  unitId: string;
}

export interface ContextPromptCoverage {
  complete: boolean;
  includedChunkIds: string[];
  pendingChunkIds: string[];
  totalChunks: number;
}

export interface PromptContextFileReference {
  chars: number;
  path: string;
  relative_path: string;
  sha256: string;
}

export interface PromptContextUnitFile extends PromptContextFileReference {
  id: string;
  kind: string;
  label: string;
  metadata?: JsonObject;
  path_in_repository?: string;
  sourceUrl?: string;
}

export interface PackedPromptContextFiles {
  full_context: PromptContextFileReference;
  index: PromptContextFileReference;
  manifest: PromptContextFileReference;
  root_dir: string;
  units: PromptContextUnitFile[];
  units_dir: string;
}

interface ContextUnitOptions {
  ignoredAuthors?: readonly string[];
}

interface PackContextOptions extends ContextUnitOptions {
  budgetChars?: number;
  chunkOverlapChars?: number;
  chunkSizeChars?: number;
  fileContext?: PackedPromptContextFiles;
}

const defaultChunkSizeChars = 12_000;
const defaultChunkOverlapChars = 1_000;
const defaultPromptBudgetChars = 80_000;

export function contentUnitsForContext(
  context: ContextPacket,
  options: ContextUnitOptions = {},
): ContentUnit[] {
  const sourceContext = contextWithoutIgnoredAuthors(context, options.ignoredAuthors);
  return [
    unit("artifact-title", "artifact", "artifact title", sourceContext.artifact.title, {
      metadata: artifactMetadata(sourceContext),
      sourceUrl: sourceContext.artifact.url,
    }),
    unit("artifact-body", "artifact", "artifact body", sourceContext.artifact.body, {
      metadata: artifactMetadata(sourceContext),
      sourceUrl: sourceContext.artifact.url,
    }),
    ...sourceContext.timeline.flatMap(timelineUnits),
    ...(sourceContext.source?.comment?.body
      ? [
          unit(
            "source-command-comment",
            "source-comment",
            "source command comment",
            sourceContext.source.comment.body,
            {
              metadata: {
                id: sourceContext.source.comment.id,
                kind: sourceContext.source.comment.kind,
                nodeId: sourceContext.source.comment.nodeId,
              },
              sourceUrl: sourceContext.source.comment.url,
            },
          ),
        ]
      : []),
    ...(sourceContext.handoffs || []).flatMap((handoff, index) => [
      unit(
        `handoff-${index}-${handoff.stage}-summary`,
        "handoff",
        `${handoff.stage} handoff summary`,
        handoff.summary,
        { metadata: handoffMetadata(handoff) },
      ),
      unit(
        `handoff-${index}-${handoff.stage}-comment`,
        "handoff",
        `${handoff.stage} handoff comment`,
        handoff.commentBody || "",
        { metadata: handoffMetadata(handoff) },
      ),
      unit(
        `handoff-${index}-${handoff.stage}-output`,
        "handoff",
        `${handoff.stage} handoff output`,
        JSON.stringify(handoff.parsedOutput),
        { metadata: handoffMetadata(handoff) },
      ),
    ]),
    ...(sourceContext.pullRequestFiles || []).map((file, index) =>
      pullRequestFileUnit(file, index),
    ),
  ].filter((item) => item.text.trim());
}

export function contentUnitsOnOrAfterCutoff(
  context: ContextPacket,
  cutoff: string,
  options: ContextUnitOptions = {},
): ContentUnit[] {
  const cutoffMs = cutoffTimeMs(cutoff);
  if (cutoffMs === undefined) return [];
  const cutoffSecondMs = Math.floor(cutoffMs / 1000) * 1000;
  return contentUnitsForContext(context, options).filter((item) => {
    const activityMs = contentUnitActivityMs(item);
    if (activityMs !== undefined) return activityMs >= cutoffSecondMs;
    return item.kind === "handoff";
  });
}

export function acceptedRiskDeltaContentUnits(options: {
  acceptedArtifactSha?: string;
  acceptedMetadata?: AcceptedRiskMetadata;
  acceptedSource?: AcceptedRiskMetadataSource;
  context: ContextPacket;
  cutoff: string;
  ignoredAuthors?: readonly string[];
}): ContentUnit[] {
  const unitOptions = { ignoredAuthors: options.ignoredAuthors };
  const allUnits = contentUnitsForContext(options.context, unitOptions);
  const units = contentUnitsOnOrAfterCutoff(options.context, options.cutoff, unitOptions).filter(
    (item) =>
      !artifactContentUnit(item) &&
      !acceptedRiskMetadataUnit(item, options.acceptedMetadata, options.acceptedSource),
  );
  const headDeltaUnits = pullRequestHeadChanged(options)
    ? allUnits.filter(pullRequestFileContentUnit)
    : [];
  if (artifactContentAccepted(options.context, options.acceptedMetadata?.artifactContentSha)) {
    return uniqueContentUnits([...units, ...headDeltaUnits]);
  }
  return uniqueContentUnits([...allUnits.filter(artifactContentUnit), ...units, ...headDeltaUnits]);
}

export function chunkContentUnits(
  units: ContentUnit[],
  options: PackContextOptions = {},
): ContentChunk[] {
  const chunkSize = options.chunkSizeChars || defaultChunkSizeChars;
  const overlap = Math.min(options.chunkOverlapChars ?? defaultChunkOverlapChars, chunkSize - 1);
  return units.flatMap((item) =>
    chunkText(item.text, { chunkSize, overlap }).map((chunk, index, chunks) => ({
      charEnd: chunk.end,
      charStart: chunk.start,
      id: `${item.id}:chunk-${index + 1}`,
      index: index + 1,
      kind: item.kind,
      label: item.label,
      metadata: item.metadata,
      path: item.path,
      sha256: sha256(chunk.text),
      sourceUrl: item.sourceUrl,
      text: chunk.text,
      total: chunks.length,
      unitId: item.id,
    })),
  );
}

export function packedContextForPrompt(
  context: ContextPacket,
  options: PackContextOptions = {},
): JsonObject {
  const sourceContext = contextWithoutIgnoredAuthors(context, options.ignoredAuthors);
  if (options.fileContext)
    return packedFileBackedContextForPrompt(sourceContext, options.fileContext);

  const units = contentUnitsForContext(sourceContext, options);
  const chunks = chunkContentUnits(units, options);
  const included = selectPromptChunks(chunks, options.budgetChars || defaultPromptBudgetChars);
  const includedIds = new Set(included.map((chunk) => chunk.id));
  const pending = chunks.filter((chunk) => !includedIds.has(chunk.id));
  return {
    artifact: packedArtifact(sourceContext),
    context_manifest: {
      chunk_overlap_chars: options.chunkOverlapChars ?? defaultChunkOverlapChars,
      chunk_size_chars: options.chunkSizeChars || defaultChunkSizeChars,
      included_chunks: included.length,
      pending_chunks: pending.length,
      pending_chunk_ids: pending.map((chunk) => chunk.id),
      total_chunks: chunks.length,
      total_units: units.length,
      units: units.map((item) => unitManifest(item, chunks, includedIds)),
    },
    generatedAt: sourceContext.generatedAt,
    handoffs: packedHandoffs(sourceContext),
    included_context_chunks: included.map(packedChunk),
    pullRequestFiles: packedPullRequestFiles(sourceContext),
    repository: sourceContext.repository,
    resolvedReviewFindingIds: sourceContext.resolvedReviewFindingIds,
    reviewScope: sourceContext.reviewScope,
    source: packedSource(sourceContext),
    timeline: sourceContext.timeline.map(packedTimelineItem),
  };
}

function packedFileBackedContextForPrompt(
  context: ContextPacket,
  fileContext: PackedPromptContextFiles,
): JsonObject {
  return {
    artifact: packedArtifact(context),
    context_files: {
      index: fileContext.index,
      manifest: fileContext.manifest,
      units_dir: fileContext.units_dir,
    },
    context_manifest: {
      delivery: "file-backed",
      handoffs: context.handoffs?.length || 0,
      index_format: "git-vibe.context-index.v1",
      pull_request_additions: sumPullRequestFileField(context, "additions"),
      pull_request_deletions: sumPullRequestFileField(context, "deletions"),
      pull_request_files: context.pullRequestFiles?.length || 0,
      timeline_items: context.timeline.length,
      total_units: fileContext.units.length,
      units_by_kind: countUnitsByKind(fileContext.units),
    },
    generatedAt: context.generatedAt,
    repository: context.repository,
    resolvedReviewFindingIds: context.resolvedReviewFindingIds,
    reviewScope: context.reviewScope,
    source: packedSource(context),
  };
}

function countUnitsByKind(units: PromptContextUnitFile[]): JsonObject {
  const counts: Record<string, number> = {};
  for (const unitItem of units) counts[unitItem.kind] = (counts[unitItem.kind] || 0) + 1;
  return counts;
}

function sumPullRequestFileField(context: ContextPacket, field: "additions" | "deletions"): number {
  return (context.pullRequestFiles || []).reduce((total, file) => total + (file[field] || 0), 0);
}

export function contextPromptCoverageForContext(
  context: ContextPacket,
  options: PackContextOptions = {},
): ContextPromptCoverage {
  const chunks = chunkContentUnits(contentUnitsForContext(context, options), options);
  const included = selectPromptChunks(chunks, options.budgetChars || defaultPromptBudgetChars);
  const includedIds = new Set(included.map((chunk) => chunk.id));
  const pendingChunkIds = chunks
    .filter((chunk) => !includedIds.has(chunk.id))
    .map((chunk) => chunk.id);
  return {
    complete: pendingChunkIds.length === 0,
    includedChunkIds: included.map((chunk) => chunk.id),
    pendingChunkIds,
    totalChunks: chunks.length,
  };
}

export function pullRequestFileText(file: PullRequestFile): string {
  return [
    `filename: ${file.filename}`,
    `status: ${file.status}`,
    file.previousFilename ? `previous filename: ${file.previousFilename}` : "",
    file.additions === undefined ? "" : `additions: ${file.additions}`,
    file.deletions === undefined ? "" : `deletions: ${file.deletions}`,
    file.changes === undefined ? "" : `changes: ${file.changes}`,
    file.blobUrl ? `blob URL: ${file.blobUrl}` : "",
    file.rawUrl ? `raw URL: ${file.rawUrl}` : "",
    file.contentsUrl ? `contents URL: ${file.contentsUrl}` : "",
    file.patch ? `patch:\n${file.patch}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function unit(
  id: string,
  kind: string,
  label: string,
  text: string,
  options: Omit<ContentUnit, "id" | "kind" | "label" | "text"> = {},
): ContentUnit {
  return { id, kind, label, text, ...options };
}

function artifactContentAccepted(context: ContextPacket, acceptedSha: string | undefined): boolean {
  return Boolean(acceptedSha && acceptedRiskArtifactContentSha(context.artifact) === acceptedSha);
}

function artifactContentUnit(item: ContentUnit): boolean {
  return item.id === "artifact-title" || item.id === "artifact-body";
}

function pullRequestFileContentUnit(item: ContentUnit): boolean {
  return item.kind === "pull-request-file";
}

function pullRequestHeadChanged(options: {
  acceptedArtifactSha?: string;
  context: ContextPacket;
}): boolean {
  if (options.context.artifact.type !== "pull-request") return false;
  const currentSha = options.context.artifact.pullRequestHead?.sha || "";
  return Boolean(
    options.acceptedArtifactSha && currentSha && currentSha !== options.acceptedArtifactSha,
  );
}

function uniqueContentUnits(units: ContentUnit[]): ContentUnit[] {
  const seen = new Set<string>();
  return units.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function acceptedRiskMetadataUnit(
  item: ContentUnit,
  acceptedMetadata: AcceptedRiskMetadata | undefined,
  acceptedSource: AcceptedRiskMetadataSource | undefined,
): boolean {
  if (!acceptedMetadata || !acceptedSource) return false;
  const itemMetadata = parseAcceptedRiskMetadata(item.text);
  return Boolean(
    acceptedRiskSourceHandoffUnit(item, acceptedSource) ||
    (itemMetadata &&
      itemMetadata.artifact === acceptedMetadata.artifact &&
      itemMetadata.number === acceptedMetadata.number &&
      itemMetadata.cutoff === acceptedMetadata.cutoff &&
      itemMetadata.artifactContentSha === acceptedMetadata.artifactContentSha &&
      acceptedRiskMetadataSourceUnit(item, acceptedSource)),
  );
}

function acceptedRiskSourceHandoffUnit(
  item: ContentUnit,
  acceptedSource: AcceptedRiskMetadataSource,
): boolean {
  const metadata = item.metadata || {};
  return (
    item.kind === "handoff" &&
    sourceField(metadata.sourceBodySha) === acceptedSource.bodySha &&
    sourceField(metadata.sourceKind) === acceptedSource.kind &&
    sourceField(metadata.sourceUrl) === acceptedSource.sourceUrl &&
    sourceIdMatches(
      {
        databaseId: metadata.sourceDatabaseId,
        id: metadata.sourceId,
      },
      acceptedSource,
    )
  );
}

function acceptedRiskMetadataSourceUnit(
  item: ContentUnit,
  acceptedSource: AcceptedRiskMetadataSource,
): boolean {
  const metadata = item.metadata || {};
  return (
    acceptedRiskMetadataBodySha(item.text) === acceptedSource.bodySha &&
    sourceField(metadata.kind) === acceptedSource.kind &&
    sourceField(item.sourceUrl) === acceptedSource.sourceUrl &&
    sourceIdMatches(metadata, acceptedSource)
  );
}

function sourceIdMatches(
  metadata: JsonObject,
  acceptedSource: AcceptedRiskMetadataSource,
): boolean {
  const ids = new Set([sourceField(metadata.id), sourceField(metadata.databaseId)].filter(Boolean));
  return Boolean(
    (acceptedSource.id && ids.has(acceptedSource.id)) ||
    (acceptedSource.databaseId && ids.has(acceptedSource.databaseId)),
  );
}

function sourceField(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function timelineUnits(item: TimelineItem, index: number): ContentUnit[] {
  const id = `timeline-${index}-${slug(item.kind)}-${slug(item.id || item.url || "item")}`;
  return [
    unit(id, "timeline", `${item.kind} ${item.id || item.url || "timeline item"}`, item.body, {
      metadata: {
        author: item.author,
        authorAssociation: item.authorAssociation,
        createdAt: item.createdAt,
        databaseId: item.databaseId,
        id: item.id,
        kind: item.kind,
        parentId: item.parentId,
        reviewThreadId: item.reviewThreadId,
        reviewThreadIsOutdated: item.reviewThreadIsOutdated,
        updatedAt: bodyTimelineKind(item.kind) ? undefined : item.updatedAt,
      },
      sourceUrl: item.url,
    }),
  ];
}

function bodyTimelineKind(kind: string): boolean {
  return kind === "body" || kind.endsWith("-body");
}

function artifactMetadata(context: ContextPacket): JsonObject {
  return {
    createdAt: context.artifact.createdAt,
    number: context.artifact.number,
    type: context.artifact.type,
  };
}

function handoffMetadata(handoff: NonNullable<ContextPacket["handoffs"]>[number]): JsonObject {
  return {
    createdAt: handoff.createdAt,
    schemaId: handoff.schemaId,
    sourceAuthor: handoff.source?.author,
    sourceBodySha: handoff.source?.bodySha,
    sourceDatabaseId: handoff.source?.databaseId,
    sourceId: handoff.source?.id,
    sourceKind: handoff.source?.kind,
    sourceUrl: handoff.source?.sourceUrl,
    stage: handoff.stage,
    status: handoff.status,
    updatedAt: handoff.updatedAt,
  };
}

function contentUnitActivityMs(item: ContentUnit): number | undefined {
  const metadata = item.metadata || {};
  const timestamps = [metadata.updatedAt, metadata.createdAt]
    .map((value) => (typeof value === "string" ? cutoffTimeMs(value) : undefined))
    .filter((value): value is number => value !== undefined);
  if (timestamps.length === 0) return undefined;
  return Math.max(...timestamps);
}

function cutoffTimeMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pullRequestFileUnit(file: PullRequestFile, index: number): ContentUnit {
  return unit(
    `pull-request-file-${index}-${slug(file.filename)}`,
    "pull-request-file",
    `pull request file ${file.filename}`,
    pullRequestFileText(file),
    {
      metadata: {
        additions: file.additions,
        changes: file.changes,
        deletions: file.deletions,
        status: file.status,
      },
      path: file.filename,
      sourceUrl: file.blobUrl || file.rawUrl || file.contentsUrl,
    },
  );
}

function chunkText(text: string, options: { chunkSize: number; overlap: number }) {
  if (text.length <= options.chunkSize) return [{ end: text.length, start: 0, text }];
  const chunks: Array<{ end: number; start: number; text: string }> = [];
  const step = Math.max(1, options.chunkSize - options.overlap);
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + options.chunkSize);
    chunks.push({ end, start, text: text.slice(start, end) });
    if (end >= text.length) break;
  }
  return chunks;
}

function selectPromptChunks(chunks: ContentChunk[], budget: number): ContentChunk[] {
  const included: ContentChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const cost = chunk.text.length + chunk.label.length + 80;
    if (included.length > 0 && used + cost > budget) continue;
    included.push(chunk);
    used += cost;
  }
  return included;
}

function unitManifest(unitItem: ContentUnit, chunks: ContentChunk[], includedIds: Set<string>) {
  const unitChunks = chunks.filter((chunk) => chunk.unitId === unitItem.id);
  return {
    chars: unitItem.text.length,
    chunk_ids: unitChunks.map((chunk) => chunk.id),
    id: unitItem.id,
    included_chunk_ids: unitChunks
      .filter((chunk) => includedIds.has(chunk.id))
      .map((chunk) => chunk.id),
    kind: unitItem.kind,
    label: unitItem.label,
    metadata: unitItem.metadata,
    pending_chunk_ids: unitChunks
      .filter((chunk) => !includedIds.has(chunk.id))
      .map((chunk) => chunk.id),
    pending_chunks: unitChunks.filter((chunk) => !includedIds.has(chunk.id)).length,
    path: unitItem.path,
    sha256: sha256(unitItem.text),
    sourceUrl: unitItem.sourceUrl,
  };
}

function packedChunk(chunk: ContentChunk): JsonObject {
  return {
    charEnd: chunk.charEnd,
    charStart: chunk.charStart,
    id: chunk.id,
    index: chunk.index,
    kind: chunk.kind,
    label: chunk.label,
    metadata: chunk.metadata,
    path: chunk.path,
    sha256: chunk.sha256,
    sourceUrl: chunk.sourceUrl,
    text: chunk.text,
    total: chunk.total,
    unitId: chunk.unitId,
  };
}

function packedArtifact(context: ContextPacket): JsonObject {
  return {
    body_chars: context.artifact.body.length,
    body_unit_id: "artifact-body",
    id: context.artifact.id,
    labels: context.artifact.labels,
    number: context.artifact.number,
    pullRequestHead: context.artifact.pullRequestHead,
    title: context.artifact.title,
    type: context.artifact.type,
    url: context.artifact.url,
  };
}

function packedTimelineItem(item: TimelineItem, index: number): JsonObject {
  return {
    author: item.author,
    authorAssociation: item.authorAssociation,
    body_chars: item.body.length,
    body_unit_id: `timeline-${index}-${slug(item.kind)}-${slug(item.id || item.url || "item")}`,
    createdAt: item.createdAt,
    databaseId: item.databaseId,
    id: item.id,
    kind: item.kind,
    parentId: item.parentId,
    reactions: item.reactions,
    reviewThreadId: item.reviewThreadId,
    reviewThreadIsOutdated: item.reviewThreadIsOutdated,
    url: item.url,
  };
}

function packedHandoffs(context: ContextPacket): JsonObject[] {
  return (context.handoffs || []).map((handoff, index) => ({
    comment_body_unit_id: `handoff-${index}-${handoff.stage}-comment`,
    parsed_output_unit_id: `handoff-${index}-${handoff.stage}-output`,
    schemaId: handoff.schemaId,
    stage: handoff.stage,
    status: handoff.status,
    summary_unit_id: `handoff-${index}-${handoff.stage}-summary`,
  }));
}

function packedPullRequestFiles(context: ContextPacket): JsonObject[] {
  return (context.pullRequestFiles || []).map((file, index) => ({
    additions: file.additions,
    blobUrl: file.blobUrl,
    changes: file.changes,
    contentsUrl: file.contentsUrl,
    deletions: file.deletions,
    filename: file.filename,
    patch_chars: file.patch?.length || 0,
    previousFilename: file.previousFilename,
    rawUrl: file.rawUrl,
    status: file.status,
    unit_id: `pull-request-file-${index}-${slug(file.filename)}`,
  }));
}

function packedSource(context: ContextPacket): JsonObject | undefined {
  const comment = context.source?.comment;
  if (!comment) return undefined;
  return {
    comment: {
      body_chars: comment.body?.length || 0,
      body_unit_id: comment.body ? "source-command-comment" : undefined,
      id: comment.id,
      kind: comment.kind,
      nodeId: comment.nodeId,
      url: comment.url,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "item"
  );
}
