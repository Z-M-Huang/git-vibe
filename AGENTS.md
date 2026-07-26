# Codex Context

## Project

GitVibe is a repository webhook server plus reusable GitHub Actions/workflows for AI-assisted development through issues, discussions, labels, workflow runs, branches, and pull requests.

The canonical long-form product, architecture, workflow, AI, and development
documentation lives in the
[GitVibe wiki](https://github.com/markhuangai/git-vibe/wiki).

## Workflow

- Do not create commits unless the user explicitly asks for a commit.
- Use `/git-vibe ...` as the only public command form.
- Do not support `@git-vibe ...`; it looks like a GitHub account mention.
- This repository's own CI runs on `self-hosted` runners only.
- Consumer example workflows may remain configurable because consumer repos may not have self-hosted runners.

## Tooling

- Runtime: Node `24`.
- Package manager version: `pnpm@10.33.3`.
- Package manager: `pnpm` via Corepack.
- If `pnpm` is not on `PATH`, use `corepack pnpm`.
- Do not use `npm install` or create `package-lock.json`.
- JavaScript/MJS size limits are enforced through ESLint.

## Checks

Run the full local gate before considering work complete:

```bash
corepack pnpm check
```

Individual checks:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm coverage
corepack pnpm actionlint
corepack pnpm audit --prod
```

Pre-commit hook:

```bash
corepack pnpm exec lint-staged
corepack pnpm typecheck
corepack pnpm coverage
```

Quality policies:

- Minimum coverage thresholds: branches 90%, functions 90%, lines 90%, statements 90%.
- Maximum JavaScript/MJS file length: 700 lines.
- Maximum JavaScript/MJS function length: 100 lines.
- Mock external boundaries in tests, not internal decisions.
- Test real behavior and regressions. Do not write tests that only confirm mocked implementation details.
- Add or update prompt/schema contract tests when changing prompts, schemas, stage routing, or structured outputs.
- Keep prompt/schema versions understandable for old workflow runs.

## Editing

- Keep files focused and under the size limits.
- Prefer deterministic code for GitHub writes; AI should return structured results that GitVibe validates and renders.
- Preserve PAT safety guidance: scope the token narrowly, never log it, and keep GitHub writes in deterministic GitVibe code.
- Do not edit generated `dist/` output. Change source files and rebuild instead.
- Do not mix broad refactors with behavior fixes. Keep unrelated cleanup out of feature and bug-fix patches.
- Do not add silent fallbacks that hide broken configuration, failed validation, missing authority, or GitHub API errors.
- Do not manually add internal `gvi:` labels unless the same flow also creates the matching hidden marker.

## Review guidelines

- Lead with bugs, regressions, security issues, data-loss risks, permission problems, and missing validation.
- Cite findings with concrete file and line references. Explain the failing scenario and why it matters.
- Sort findings by severity. Keep summaries brief and after the findings.
- Do not block on formatting or style that Prettier, ESLint, TypeScript, coverage, or actionlint already enforce.
- Treat missing or weak tests as findings when behavior, contracts, workflows, permissions, prompts, schemas, or GitHub writes change.
- Verify deterministic GitHub writes stay in GitVibe code. AI output should remain structured data that GitVibe validates and renders.
- Check token safety on every path that touches PATs, provider keys, CLI auth, logs, comments, artifacts, or workflow output.
