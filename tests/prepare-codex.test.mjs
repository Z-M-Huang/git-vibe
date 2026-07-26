// @ts-nocheck
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex preparation script", () => {
  it("exports the Codex executable without overriding CODEX_HOME", () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-prepare-"));
    const executable = join(cwd, "codex");
    const githubEnv = join(cwd, "github-env");
    const runnerTemp = join(cwd, "runner-temp");
    writeFileSync(executable, "#!/usr/bin/env bash\necho codex 0.0.0\n");
    chmodSync(executable, 0o755);

    try {
      const result = spawnSync("bash", ["scripts/prepare-codex.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: join(cwd, "persistent-codex-home"),
          GITHUB_ENV: githubEnv,
          GITVIBE_CODEX_PATH: executable,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const exportedEnv = readFileSync(githubEnv, "utf8");

      expect(result.status).toBe(0);
      expect(exportedEnv).toContain(`GITVIBE_CODEX_PATH=${executable}`);
      expect(exportedEnv).not.toContain("CODEX_HOME=");
      expect(exportedEnv).not.toContain("persistent-codex-home");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails when an explicitly configured executable cannot start", () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-prepare-"));
    const executable = join(cwd, "codex");
    writeExecutable(executable, "#!/usr/bin/env bash\nexit 1\n");

    try {
      const result = spawnSync("bash", ["scripts/prepare-codex.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITVIBE_CODEX_PATH: executable,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        `::error::GITVIBE_CODEX_PATH failed Codex executable validation: ${executable}`,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe("Codex preparation fallback", () => {
  it("replaces broken implicit and cached executables with the pinned Codex version", () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-vibe-codex-prepare-"));
    const binDir = join(cwd, "bin");
    const cacheRoot = join(cwd, "provider-cache");
    const version = codexVersion();
    const cachedExecutable = join(cacheRoot, `codex-${version}`, "node_modules", ".bin", "codex");
    const githubEnv = join(cwd, "github-env");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(cachedExecutable, ".."), { recursive: true });
    writeExecutable(
      join(binDir, "node"),
      [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == *"/scripts/resolve-codex-path.mjs" ]]; then exit 1; fi',
        'exec "$REAL_NODE" "$@"',
        "",
      ].join("\n"),
    );
    writeExecutable(join(binDir, "codex"), "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(cachedExecutable, "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(
      join(binDir, "pnpm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--dir" ]; then install_dir="$2"; shift 2; else shift; fi',
        "done",
        'executable="$install_dir/node_modules/.bin/codex"',
        'mkdir -p "$(dirname "$executable")"',
        `printf '%s\\n' '#!/usr/bin/env bash' 'echo codex ${version}' > "$executable"`,
        'chmod +x "$executable"',
        "",
      ].join("\n"),
    );

    try {
      const result = spawnSync("bash", ["scripts/prepare-codex.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ENV: githubEnv,
          GITVIBE_CODEX_PATH: "",
          GITVIBE_PROVIDER_CACHE_DIR: cacheRoot,
          PATH: `${binDir}:${process.env.PATH}`,
          REAL_NODE: process.execPath,
        },
      });
      const exportedEnv = readFileSync(githubEnv, "utf8");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `::warning::Ignoring unusable Codex executable on PATH at ${join(binDir, "codex")}.`,
      );
      expect(result.stdout).toContain(
        `::warning::Replacing unusable cached Codex executable at ${cachedExecutable}.`,
      );
      expect(result.stdout).toContain(`Using Codex executable at ${cachedExecutable}`);
      expect(exportedEnv).toContain(`GITVIBE_CODEX_PATH=${cachedExecutable}`);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

function codexVersion() {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  return packageJson.dependencies["@openai/codex-sdk"].match(/\d+\.\d+\.\d+/)[0];
}

function writeExecutable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}
