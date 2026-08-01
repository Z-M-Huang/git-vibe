import type {
  ContextPacket,
  GitVibeConfig,
  RunnerOptions,
  StageRunResult,
} from "../shared/types.js";
import { safetyIgnoredAuthors } from "./ignored-authors.js";
import type { StageLogger } from "./logging.js";
import { safetyContextDigest } from "./safety-gate.js";

export interface StageSecurityReviewResult {
  allowed: boolean;
  inputSafetyDigest?: string;
  result?: StageRunResult;
  reviewScope?: ContextPacket["reviewScope"];
  status: string;
  summary: string;
}

export function securityReviewResultWithAttestation(options: {
  config: GitVibeConfig;
  context: ContextPacket;
  result: StageSecurityReviewResult;
}): StageSecurityReviewResult {
  if (!options.context.reviewScope) return options.result;
  return {
    ...options.result,
    inputSafetyDigest: reviewInputSafetyDigest(options),
    reviewScope: options.context.reviewScope,
  };
}

export function reuseReviewInputSafetyAttestation(options: {
  config: GitVibeConfig;
  context: ContextPacket;
  logger: StageLogger;
  runner: RunnerOptions;
}): boolean {
  const expectedDigest = options.runner.review?.inputSafetyDigest;
  if (!expectedDigest) return false;
  const actualDigest = reviewInputSafetyDigest(options);
  if (actualDigest === expectedDigest) {
    options.logger.event("safety.input_attestation.reused", { digest: actualDigest });
    return true;
  }
  options.logger.event("safety.input_attestation.mismatch", {
    actual_digest: actualDigest,
    expected_digest: expectedDigest,
  });
  return false;
}

function reviewInputSafetyDigest(options: {
  config: GitVibeConfig;
  context: ContextPacket;
}): string {
  return safetyContextDigest({
    context: options.context,
    ignoredAuthors: safetyIgnoredAuthors(options.config),
  });
}
