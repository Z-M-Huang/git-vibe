import { parseStage } from "./stages.js";
import type { Stage } from "./types.js";

export interface StageResultMarker {
  artifact: "discussion" | "issue" | "pull-request";
  baseSha?: string;
  headSha?: string;
  reviewVersion?: string;
  number: string;
  run?: string;
  snapshotSha?: string;
  stage: Stage;
}

export const reviewCheckpointVersion = "1";

export function parseStageResultMarker(
  body: string | null | undefined,
): StageResultMarker | undefined {
  const match = String(body || "").match(/<!--\s*git-vibe:stage-result\s+([^>]*)-->/);
  if (!match) return undefined;

  const attributes = parseAttributes(match[1] || "");
  const artifact = artifactField(attributes.artifact);
  const number = stringField(attributes.number);
  if (!artifact || !number || !attributes.stage) return undefined;

  try {
    const baseSha = stringField(attributes["base-sha"]);
    const headSha = stringField(attributes["head-sha"]);
    const reviewVersion = stringField(attributes["review-version"]);
    const run = stringField(attributes.run);
    const snapshotSha = stringField(attributes["snapshot-sha"]);
    return {
      artifact,
      ...(baseSha ? { baseSha } : {}),
      ...(headSha ? { headSha } : {}),
      ...(reviewVersion ? { reviewVersion } : {}),
      number,
      ...(run ? { run } : {}),
      ...(snapshotSha ? { snapshotSha } : {}),
      stage: parseStage(attributes.stage),
    };
  } catch {
    return undefined;
  }
}

export function stageResultStatus(body: string | null | undefined): string {
  const line = String(body || "")
    .split(/\r?\n/)
    .find((value) => value.includes("**Status:**"));
  return normalizedState(line?.match(/`([^`]+)`/)?.[1]);
}

function parseAttributes(value: string): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const match of value.matchAll(/([a-z][a-z-]*)=([^\s>]+)/g)) {
    attributes[match[1] || ""] = match[2];
  }
  return attributes;
}

function artifactField(value: string | undefined): StageResultMarker["artifact"] | undefined {
  if (value === "discussion" || value === "issue" || value === "pull-request") return value;
  return undefined;
}

function normalizedState(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function stringField(value: string | undefined): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}
