import { createHash } from "node:crypto";

export interface ReviewFindingAnchor {
  body: string;
  line: number;
  path: string;
  startLine?: number;
}

export function effectiveReviewFindingId(
  options: ReviewFindingAnchor & { explicitFindingId?: unknown; rawBody: string },
): string {
  return (
    normalizedFindingId(options.explicitFindingId) ||
    reviewFindingMarkerId(options.rawBody) ||
    generatedFindingId(options)
  );
}

export function generatedFindingId(options: ReviewFindingAnchor): string {
  const fingerprint = [options.path, options.startLine || "", options.line, options.body]
    .map((part) => String(part).trim())
    .join("\0");
  return `gv-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`;
}

export function normalizedFindingId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id) ? id : undefined;
}

export function reviewFindingMarker(id: string): string {
  return `<!-- git-vibe:review-finding id=${id} -->`;
}

export function reviewFindingMarkerId(body: string): string | undefined {
  const match = body.match(/<!--\s*git-vibe:review-finding\s+([^>]*)-->/);
  const id = match?.[1]?.match(/(?:^|\s)id=([^\s>]+)/)?.[1];
  return normalizedFindingId(id);
}

export function reviewFindingUnanchoredMarker(id: string): string {
  return `<!-- git-vibe:review-finding-unanchored id=${id} -->`;
}

export function reviewFindingUnanchoredMarkerIds(body: string): string[] {
  return [...body.matchAll(/<!--\s*git-vibe:review-finding-unanchored\s+([^>]*)-->/g)].flatMap(
    (match) => {
      const id = match[1]?.match(/(?:^|\s)id=([^\s>]+)/)?.[1];
      const normalized = normalizedFindingId(id);
      return normalized ? [normalized] : [];
    },
  );
}

export function visibleReviewCommentBody(body: string): string {
  return body
    .replace(/<!--\s*git-vibe:review-finding(?:-(?:unanchored|update))?\s+[^>]*-->\s*/g, "")
    .trim();
}
