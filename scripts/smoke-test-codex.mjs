#!/usr/bin/env node

import { Codex } from "@openai/codex-sdk";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ error(message: string): void, log(message: string): void }} Logger
 * @typedef {{ apiKey: string, baseUrl: string, env: NodeJS.ProcessEnv, model: string, profileName: string, reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh", secrets: string[] }} CodexSmokeConfig
 * @typedef {{ ok: boolean, source: "codex" }} CodexSmokeOutput
 * @typedef {{ Codex: typeof Codex }} CodexSmokeDependencies
 */

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "source"],
  properties: {
    ok: { type: "boolean" },
    source: { enum: ["codex"] },
  },
};

/** @type {CodexSmokeDependencies} */
const defaultDependencies = { Codex };

if (isDirectRun(import.meta.url, process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}

/**
 * @param {{ cwd?: string, dependencies?: CodexSmokeDependencies, env?: Env, logger?: Logger }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  cwd = process.cwd(),
  dependencies = defaultDependencies,
  env = process.env,
  logger = console,
} = {}) {
  try {
    const report = await runCodexSmokeTest({ cwd, dependencies, env });
    logger.log(
      `[git-vibe] codex-sdk smoke passed with profile=${report.profileName} model=${report.model}`,
    );
    return 0;
  } catch (error) {
    logger.error(`[git-vibe] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * @param {{ cwd: string, dependencies?: CodexSmokeDependencies, env: Env }} options
 * @returns {Promise<Pick<CodexSmokeConfig, "model" | "profileName">>}
 */
export async function runCodexSmokeTest({ cwd, dependencies = defaultDependencies, env }) {
  const config = readCodexSmokeConfig({ cwd, env });
  const codexHome = mkdtempSync(join(tmpdir(), "git-vibe-codex-smoke-home-"));
  try {
    const codex = new dependencies.Codex({
      ...(env.GITVIBE_CODEX_PATH ? { codexPathOverride: env.GITVIBE_CODEX_PATH } : {}),
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      config: { features: { plugins: false }, model_provider: "openai" },
      env: stringEnv({ ...config.env, CODEX_HOME: codexHome }),
    });
    const thread = codex.startThread({
      approvalPolicy: "never",
      model: config.model,
      modelReasoningEffort: config.reasoningEffort,
      sandboxMode: "danger-full-access",
      skipGitRepoCheck: true,
      workingDirectory: cwd,
    });
    const result = await thread.run(
      'Return exactly this JSON object: {"ok": true, "source": "codex"}. Do not modify files.',
      { outputSchema },
    );
    const output = codexOutput(result.finalResponse, config.secrets);
    if (output.ok !== true || output.source !== "codex") {
      throw new Error(
        `unexpected Codex SDK smoke response: ${redact(JSON.stringify(output), config.secrets)}`,
      );
    }
  } finally {
    rmSync(codexHome, { force: true, recursive: true });
  }
  return { model: config.model, profileName: config.profileName };
}

/**
 * @param {{ cwd: string, env: Env }} options
 * @returns {CodexSmokeConfig}
 */
export function readCodexSmokeConfig({ cwd, env }) {
  const config = readGitVibeConfig(cwd);
  const { profile, profileName } = codexProfile(config, env.GITVIBE_AI_SMOKE_CODEX_PROFILE);
  const bundle = aiEnvBundle(env);
  const childEnv = sanitizedChildEnv(env);
  const profileEnvConfig =
    profile.env === undefined ? {} : recordValue(profile.env, `ai.profiles.${profileName}.env`);
  for (const [target, source] of Object.entries(profileEnvConfig)) {
    if (!target.trim())
      throw new Error(`ai.profiles.${profileName}.env keys must be non-empty strings.`);
    childEnv[target] = envValue(source, bundle, `ai.profiles.${profileName}.env.${target}`);
  }
  delete childEnv.CODEX_HOME;
  const model = stringValue(profile.model);
  if (!model) throw new Error(`AI profile ${profileName} model must be configured.`);
  const effort = stringValue(recordValueOrEmpty(profile.reasoning).effort);
  const reasoningEffort = codexReasoningEffort(effort);
  const baseUrl = requiredBundleValue(
    profile.base_url,
    bundle,
    `ai.profiles.${profileName}.base_url`,
  );
  validateHttpBaseUrl(baseUrl, `ai.profiles.${profileName}.base_url`);
  const apiKey = requiredBundleValue(profile.api_key, bundle, `ai.profiles.${profileName}.api_key`);

  return {
    apiKey,
    baseUrl,
    env: childEnv,
    model,
    profileName,
    reasoningEffort,
    secrets: Object.values(bundle),
  };
}

/**
 * @param {string | undefined} effort
 * @returns {CodexSmokeConfig["reasoningEffort"]}
 */
function codexReasoningEffort(effort) {
  if (!effort) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    return /** @type {CodexSmokeConfig["reasoningEffort"]} */ (effort);
  }
  throw new Error(`AI profile reasoning.effort is not supported by codex-sdk: ${effort}.`);
}

/**
 * @param {unknown} source
 * @param {Record<string, string>} bundle
 * @param {string} path
 * @returns {string}
 */
function requiredBundleValue(source, bundle, path) {
  if (source === undefined) throw new Error(`${path} is required for codex-sdk profiles.`);
  const value = envValue(source, bundle, path);
  const trimmed = stringValue(value);
  if (!trimmed) throw new Error(`${path}.from_bundle resolved to an empty value.`);
  return trimmed.trim();
}

/**
 * @param {string} value
 * @param {string} path
 */
function validateHttpBaseUrl(value, path) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${path}.from_bundle must resolve to an absolute HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${path}.from_bundle must resolve to an absolute HTTP(S) URL.`);
  }
}

/**
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function readGitVibeConfig(cwd) {
  const path = resolve(cwd, ".github/git-vibe.yml");
  if (!existsSync(path)) throw new Error(".github/git-vibe.yml is required for Codex SDK smoke.");
  const parsed = parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".github/git-vibe.yml must contain a YAML object.");
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} config
 * @param {string | undefined} requestedProfile
 * @returns {{ profile: Record<string, unknown>, profileName: string }}
 */
function codexProfile(config, requestedProfile) {
  const profiles = recordValue(recordValue(config.ai, "ai").profiles, "ai.profiles");
  const requested = stringValue(requestedProfile);
  if (requested) return namedCodexProfile(profiles, requested);
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (isCodexProfile(profile)) return { profile, profileName };
  }
  throw new Error(".github/git-vibe.yml does not define an enabled codex-sdk profile.");
}

/**
 * @param {Record<string, unknown>} profiles
 * @param {string} profileName
 * @returns {{ profile: Record<string, unknown>, profileName: string }}
 */
function namedCodexProfile(profiles, profileName) {
  const profile = profiles[profileName];
  if (!isCodexProfile(profile)) {
    throw new Error(`AI profile ${profileName} must be an enabled codex-sdk profile.`);
  }
  return { profile, profileName };
}

/**
 * @param {unknown} profile
 * @returns {profile is Record<string, unknown>}
 */
function isCodexProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const record = /** @type {Record<string, unknown>} */ (profile);
  return Boolean(record.adapter === "codex-sdk" && record.enabled !== false);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function recordValue(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordValueOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} source
 * @param {Record<string, string>} bundle
 * @param {string} path
 * @returns {string}
 */
function envValue(source, bundle, path) {
  if (typeof source === "string") return source;
  const record = recordValue(source, path);
  const bundleKey = stringValue(record.from_bundle);
  if (!bundleKey) throw new Error(`${path}.from_bundle must be a non-empty string.`);
  if (!(bundleKey in bundle)) {
    throw new Error(`GITVIBE_AI_ENV_JSON.${bundleKey} is required by ${path}.from_bundle.`);
  }
  return bundle[bundleKey];
}

/**
 * @param {Env} env
 * @returns {Record<string, string>}
 */
function aiEnvBundle(env) {
  const raw = env.GITVIBE_AI_ENV_JSON;
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GITVIBE_AI_ENV_JSON must be a JSON object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`GITVIBE_AI_ENV_JSON.${key} must be a string.`);
  }
  return /** @type {Record<string, string>} */ (parsed);
}

/**
 * @param {Env} env
 * @returns {NodeJS.ProcessEnv}
 */
function sanitizedChildEnv(env) {
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) {
    if (name === "GITVIBE_AI_ENV_JSON" || sensitiveEnvName(name)) delete childEnv[name];
  }
  return childEnv;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function sensitiveEnvName(name) {
  return /(AUTH|AUTHORIZATION|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)/i.test(name);
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {CodexSmokeOutput}
 */
function codexOutput(text, secrets) {
  return /** @type {CodexSmokeOutput} */ (JSON.parse(extractJsonObject(text, secrets)));
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function extractJsonObject(text, secrets) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  throw new Error(`Codex SDK result did not contain JSON: ${excerpt(redact(text, secrets))}`);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
function stringEnv(env) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function redact(text, secrets) {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("***") : result),
    text,
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} scriptPath
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl, scriptPath) {
  return Boolean(scriptPath && moduleUrl === pathToFileURL(scriptPath).href);
}
