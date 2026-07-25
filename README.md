<h1 align="center">GitVibe</h1>

<p align="center">
  <img src="https://img.shields.io/badge/GitVibe-AI_repo_workflow-2563eb?style=for-the-badge&logo=githubactions&logoColor=white" alt="GitVibe" />
</p>

<p align="center">
  <strong>Turn GitHub issues, discussions, labels, Actions, and pull requests into a maintainer-gated AI workflow.</strong>
</p>

<p align="center">
  <a href="https://github.com/markhuangai/git-vibe"><img src="https://img.shields.io/github/stars/markhuangai/git-vibe?style=flat-square&logo=github" alt="GitHub stars" /></a>
  <a href="https://github.com/markhuangai/git-vibe/issues"><img src="https://img.shields.io/github/issues/markhuangai/git-vibe?style=flat-square&logo=github" alt="GitHub issues" /></a>
  <a href="https://github.com/markhuangai/git-vibe/blob/main/LICENSE"><img src="https://img.shields.io/github/license/markhuangai/git-vibe?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-22-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/pnpm-10.33.3-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 10.33.3" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-6.0+-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 6" />
  <img src="https://img.shields.io/badge/coverage-%3E%3D90%25-brightgreen?style=flat-square" alt="Coverage threshold" />
  <img src="https://img.shields.io/badge/Docker-GHCR-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker image on GHCR" />
  <img src="https://img.shields.io/badge/Claude%20Code%20%2B%20Codex-SDKs-111827?style=flat-square" alt="Claude Code and Codex SDK adapters" />
  <img src="https://visitor-badge.laobi.icu/badge?page_id=markhuangai.git-vibe&style=flat-square" alt="Visitors" />
</p>

<p align="center">
  <a href="#what-it-does">What it does</a> &nbsp;|&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;|&nbsp;
  <a href="#commands">Commands</a> &nbsp;|&nbsp;
  <a href="#configuration">Configuration</a> &nbsp;|&nbsp;
  <a href="#security-model">Security</a> &nbsp;|&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;|&nbsp;
  <a href="#development">Development</a>
</p>

---

## What it does

GitVibe is a hosted GitHub App automation layer for teams that want AI help
without moving product decisions, review, or merge authority out of GitHub.

It listens to GitHub App webhooks, verifies who is allowed to act, dispatches
reusable GitHub workflows, runs stage-specific AI workers, validates structured
AI output, and writes routine GitHub state changes with deterministic code.

| GitHub problem                                  | GitVibe answer                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Bug reports need triage before code changes     | Investigate first, ask for expected behavior, validate maintainer context, then hand off clear findings |
| Feature requests become scattered issue threads | Start in Discussions, validate acceptance criteria, then materialize one or more implementation issues  |
| AI tools can bypass normal repo process         | Keep approvals, labels, comments, issues, reviews, and merges inside GitHub                             |
| Agent output is hard to audit                   | Require structured stage results, render traceable comments, and keep hidden source markers             |
| Consumer repositories should stay small         | Copy tiny `.github` and `.git-vibe` starters and call reusable workflows from `markhuangai/git-vibe`    |

## Pipeline at a glance

```mermaid
flowchart LR
  A[Issue, Discussion, or PR] --> B["/git-vibe command or public trigger label"]
  B --> C[Webhook server validates actor and marker]
  C --> D[Reusable GitHub workflow]
  D --> E[Plan stage matrix]
  E --> F[Member AI worker jobs]
  F --> G[Finalizer validates one stage result]
  G --> H{Deterministic GitVibe write}
  H --> I[Comment, label, or issue]
  I --> J[Human implementation, review, and merge]
```

GitVibe does not write code, open pull requests, auto-merge, approve its own pull
requests, or treat AI output as authority. Maintainers stay in control of
implementation, review, and release decisions.

## Workflows

| Workflow          | Use it for                                                            | Writes code?    |
| ----------------- | --------------------------------------------------------------------- | --------------- |
| `investigate.yml` | Bug investigation and likely-root-cause analysis                      | No              |
| `validate.yml`    | Check whether maintainer context is coherent and actionable           | No              |
| `materialize.yml` | Convert a validated Discussion into one or more implementation issues | No              |
| `review.yml`      | Review an existing pull request with the configured review matrix     | No              |
| `ai-smoke.yml`    | Verify configured SDK adapters on a runner                            | No repo changes |

The reusable workflows install Node `22` and pnpm `10.33.3` before building the
source-backed composite actions. Each composite action then reads
`.github/git-vibe.yml` for its stage and runs the selected `codex-sdk` or
`claude-code-sdk` profile directly through its SDK adapter.

GitVibe workflows and composite actions support Linux and macOS GitHub Actions
runners. Windows runners are not supported by this repository. Stage actions do
not prepare every SDK executable up front; the selected SDK adapter resolves its
native executable after GitVibe selects the configured profile. The AI smoke
workflow still runs the executable preparation scripts directly so runner images
can be validated.

`review.yml` runs the same PR-scoped review matrix for an existing pull request.
Trusted maintainers trigger it with the `git-vibe:review` label on a PR. GitVibe
removes stale ready/blocked state, adds `gvi:reviewing`, and then marks the PR
ready or blocked based on the review result.

The old development and PR feedback remediation workflows are removed. Applying
`git-vibe:approved` to an issue is a trusted no-op; applying it to a validated
Discussion still dispatches `materialize.yml`.

## Quick Start

### 1. Install the consumer starter

Run this from the repository that should use GitVibe:

```bash
npx git-vibe-setup setup
```

`git-vibe-setup setup` fetches the latest stable `markhuangai/git-vibe` release,
copies the consumer starter from this repository, pins generated reusable
workflow refs to that release tag, and stops without writing if any target file
already exists.

It creates:

- `.github/git-vibe.yml`
- `.github/workflows/*.yml`
- `.git-vibe/role-group/*.md`

The installer is local-only. It does not create commits, open pull requests, or
write secrets and variables for you. When `GITHUB_TOKEN` or `GH_TOKEN` is set,
`git-vibe-setup` uses it only to authenticate GitHub release and starter-file
reads so CI or shared-network runs avoid anonymous API throttling.

To update existing GitVibe workflow wrappers after upgrading `git-vibe-setup`,
run:

```bash
npx git-vibe-setup update
```

`update` rewrites only `.github/workflows/*.yml` GitVibe wrapper files and pins
them to the latest stable GitVibe release. It does not touch
`.github/git-vibe.yml`, `.git-vibe`, secrets, or variables, and it refuses to
overwrite workflow files that do not look like GitVibe wrappers.

For prerelease testing, pin an exact release tag from the consumer repository:

```bash
npx git-vibe-setup update --release v3.0.4-rc.1
```

Use `--include-prereleases` only when automatic latest-release lookup should be
allowed to choose prereleases.

### 2. Configure the consumer repo

Edit:

```text
.github/git-vibe.yml
```

The starter workflows call the public reusable workflow namespace:

```yaml
jobs:
  validate:
    uses: markhuangai/git-vibe/.github/workflows/validate.yml@<latest-stable-tag>
```

Reusable workflows operate on the repository where the workflow run starts
(`github.repository`). GitVibe does not accept a separate `owner/repo` workflow
input.

### 3. Add secrets and variables

Secrets belong in GitHub repository or organization secrets, not in
`.github/git-vibe.yml`.

`git-vibe-setup` prints this list after it writes files. It does not collect or
store secret values.

| Name                   | Required | Purpose                                               |
| ---------------------- | -------- | ----------------------------------------------------- |
| `GITVIBE_AI_ENV_JSON`  | Yes      | JSON env bundle for SDK auth and provider variables   |
| `GITVIBE_MCP_ENV_JSON` | No       | JSON env bundle for configured MCP server credentials |

Useful variables:

```text
GITVIBE_BASE_BRANCH
GITVIBE_DISCUSSION_CATEGORY
GITVIBE_RUNNER
GITVIBE_LOG_LEVEL
```

Store AI provider values in `GITVIBE_AI_ENV_JSON`:

```json
{
  "ANTHROPIC_BASE_URL": "https://api.provider.example/anthropic",
  "CODEX_BASE_URL": "https://codex-proxy.example/v1",
  "GITVIBE_AI_API_KEY": "..."
}
```

Store MCP credentials separately in `GITVIBE_MCP_ENV_JSON` when stages use
`ai.mcp.servers`:

```json
{
  "DENSE_MEM_API_KEY": "...",
  "PRIVATE_DOCS_TOKEN": "..."
}
```

Codex profiles require `base_url` and `api_key` fields in `.github/git-vibe.yml`.
GitVibe passes those values to the Codex SDK directly; it does not read or
write `~/.codex/auth.json`.

Hosted GitVibe uses the installed GitHub App for GitHub writes. Customers do not
create a repo-level webhook or `GITVIBE_GITHUB_TOKEN` secret.

### 4. Run the app server

For local source runs:

```bash
corepack pnpm build:app
GITHUB_APP_ID=... \
GITHUB_WEBHOOK_SECRET=... \
GITVIBE_APP_PRIVATE_KEY=... \
corepack pnpm start
```

For Docker Compose:

```bash
GITHUB_APP_ID=... \
GITHUB_WEBHOOK_SECRET=... \
GITVIBE_APP_PRIVATE_KEY=... \
docker compose up -d
```

Runtime variables:

| Name                            | Required | Notes                                                     |
| ------------------------------- | -------- | --------------------------------------------------------- |
| `GITHUB_APP_ID`                 | Yes      | GitHub App ID                                             |
| `GITHUB_WEBHOOK_SECRET`         | Yes      | Must match the GitHub App webhook secret                  |
| `GITVIBE_ACTIONS_OIDC_AUDIENCE` | Optional | Defaults to `https://git-vibe.markhuang.ai/actions/token` |
| `GITVIBE_APP_PRIVATE_KEY`       | Yes      | GitHub App private key                                    |
| `GITHUB_API_URL`                | Optional | Defaults to `https://api.github.com`                      |
| `GITVIBE_DISCUSSION_CATEGORY`   | Optional | Defaults to `Ideas`                                       |

Workflow dispatches use the repository variable `GITVIBE_BASE_BRANCH` as the
workflow ref. Empty or missing means GitVibe uses the repository
`default_branch` reported by GitHub.

### 5. Install the GitHub App

Install the hosted GitVibe GitHub App from
[GitVibe for GitHub](https://github.com/apps/gitvibe-for-github) on the
repositories you want GitVibe to manage. The App registration owns webhook
delivery, so repositories do not create repo-level webhooks.

Hosted GitVibe App registration values for operators:

```text
Homepage URL: https://markhuang.ai/manuals/git-vibe
Setup URL: https://markhuang.ai/manuals/git-vibe/repository-settings
Webhook URL: https://git-vibe.markhuang.ai/webhooks
Callback URL: blank
Request user authorization during installation: off
Device flow: off
```

Subscribe the App to these webhook events:

```text
Installation
Installation repositories
Issues
Issue comments
Sub-issues
Discussions
Discussion comments
Pull requests
Pull request reviews
```

Repository permissions for the GitVibe App registration:

```text
Actions: Read and write
Checks: Read-only
Contents: Read and write
Discussions: Read and write
Issues: Read and write
Pull requests: Read and write
Variables: Read-only
Workflows: Read and write
```

These are permissions on the hosted GitVibe App installation. Customer
repositories do not create GitHub environments for hosted auth.

Do not use "Send me everything"; GitVibe only needs the curated event set above.

## Commands And Labels

Use `/git-vibe` for the remaining comment-triggered workflows:

| Command                 | Typical surface | Effect                                                        |
| ----------------------- | --------------- | ------------------------------------------------------------- |
| `/git-vibe investigate` | Bug issue       | Runs investigation-only analysis and posts findings/questions |

Use protected labels for investigation, validation, materialization, and approval transitions:

| Label                  | Typical surface     | Effect                                                                         |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `git-vibe:investigate` | Bug issue           | Runs investigation, then GitVibe replaces the trigger with `gvi:investigating` |
| `git-vibe:validate`    | Issue or Discussion | Runs validation, then GitVibe removes the trigger label                        |
| `git-vibe:approved`    | Issue               | Trusted no-op retained for compatibility                                       |
| `git-vibe:approved`    | Feature Discussion  | Dispatches materialization after `gvi:validated`                               |
| `git-vibe:review`      | Pull request        | Dispatches PR review and marks the PR `gvi:reviewing` while it runs            |

`@git-vibe ...` is intentionally unsupported so commands do not look like GitHub
account mentions.

Accepted comment commands from admins and collaborators receive a `rocket`
reaction before GitVibe dispatches the workflow. When the reaction succeeds,
GitVibe does not also post a queued comment. If the reaction cannot be added,
GitVibe posts the queued workflow comment as a visible fallback.

Protected label dispatches also post queued comments after dispatch succeeds.
The queued comment includes the exact workflow run URL when GitHub returns it;
runner stages still post a separate running comment when the GitHub Actions job
starts. Approval reviews and `changes_requested` reviews do not start
remediation automation.

## Configuration

The main consumer config file is:

```text
.github/git-vibe.yml
```

Minimal shape:

```yaml
version: 1

github_auth:
  mode: github-app

safety:
  # Enabled by default. Set false to skip input/output prompt-injection scans.
  prompt_injection_gate: true
  # CodeRabbit authors are ignored by default. Add more bot authors here.
  ignored_authors:
    - custom-review-bot[bot]

ai:
  profiles:
    codex_sdk:
      adapter: codex-sdk
      api_key:
        from_bundle: GITVIBE_AI_API_KEY
      base_url:
        from_bundle: CODEX_BASE_URL
      model: gpt-5.5
      reasoning:
        effort: high
    claude_code:
      adapter: claude-code-sdk
      env:
        ANTHROPIC_API_KEY:
          from_bundle: GITVIBE_AI_API_KEY
        ANTHROPIC_BASE_URL:
          from_bundle: ANTHROPIC_BASE_URL
        ANTHROPIC_DEFAULT_OPUS_MODEL: kimi-k2.5
        ANTHROPIC_DEFAULT_SONNET_MODEL: kimi-k2.5
        ANTHROPIC_DEFAULT_HAIKU_MODEL: kimi-k2.5
        ANTHROPIC_MODEL: opus
        CLAUDE_CODE_SUBAGENT_MODEL: opus
      model: opus
      reasoning:
        effort: max
      # Optional explicit repo context appended to GitVibe's rendered prompt.
      # Native SDKs may also load their installed user/project configuration.
      # context:
      #   files:
      #     - AGENTS.md
  # Optional MCP servers. Stage entries decide which server tools are available.
  # Credentials referenced with from_bundle are read from GITVIBE_MCP_ENV_JSON.
  # mcp:
  #   servers:
  #     dense_mem:
  #       transport: stdio
  #       command: node
  #       args: ["./scripts/dense-mem-mcp.js"]
  #       env:
  #         DENSE_MEM_API_KEY:
  #           from_bundle: DENSE_MEM_API_KEY
  role_groups:
    review_gate:
      synthesizer: codex_sdk
      parallel: 2
      roles:
        - role: correctness.md
          profile: claude_code
        - role: security.md
          profile: claude_code
  stages:
    investigate:
      role_group: review_gate
    validate:
      role_group: review_gate
    materialize:
      profile: codex_sdk
    review-matrix:
      role_group: review_gate
      # mcp:
      #   dense_mem:
      #     required: false
      #     tools: ["search_memory"]

tests:
  commands: []
```

GitVibe uses `/git-vibe ...` as the fixed public command form. Command prefixes,
external agent mentions, permissions, and label names are not configurable.

`safety.prompt_injection_gate` controls the AI prompt-injection gate. When it is
`true` or omitted, GitVibe scans untrusted input before a stage and scans stage
output before publishing. When it is `false`, GitVibe skips both scans.
`safety.ignored_authors` adds GitHub logins whose timeline comments and reviews
are omitted from prompt-injection scans and model context. CodeRabbit
(`coderabbitai` and `coderabbitai[bot]`) is ignored by default.

Each AI stage must define `profile` or `role_group`; GitVibe fails fast instead of
falling back to a profile name the repository may not have configured.
Role definitions referenced by `role_group` live in `.git-vibe/role-group/*.md`.
SDK adapters use the Codex SDK and Claude Code SDK directly; profiles choose
adapter, model, auth, env, and reasoning settings. They use native structured
output schema support and do not receive `output_validator` tool-call
instructions.
GitHub context bodies, handoffs, and PR patches are persisted as runner-local
context files. The initial prompt carries a compact JSONL index, aggregate counts,
and file references so SDK agents can search for relevant units and read exact
evidence with native file tools instead of receiving large inline prompt payloads.
The detailed manifest and complete serialized context remain on disk for cases
that require hashes or full metadata.
Claude Code auto-compaction remains enabled and controlled by the SDK. Custom
proxy profiles can set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in their profile `env` when the proxy's actual
context window differs from the model alias reported to Claude Code.
Profiles may opt into shared repository guidance with
`ai.profiles.<name>.context.files`. Listed files are appended to the rendered
system prompt for that profile. Native SDK adapters may also load their
installed user/project configuration.

Stages may also opt into MCP servers through `ai.stages.<stage>.mcp`. Each
server can expose a flat `tools` list to the model. For advanced deterministic
pre-model context, use `allow_tools.context` with `context_calls`; those results
are injected into the prompt before the model runs. Model tools are exposed to AI
through Codex SDK and Claude Code SDK MCP configuration, backed by a GitVibe
gateway that enforces the stage allowlist. `required` defaults to `true`; set it
to `false` when missing MCP context should warn instead of blocking the stage.

Set `tests.commands` to the consumer repository's own verification gate, such as
its lint, typecheck, unit test, or integration test commands.

Optional repository prompt additions live under
`.git-vibe/prompts/<stage>/system.md` and `.git-vibe/prompts/<stage>/user.md`.
They append to GitVibe's built-in prompts without replacing stage contracts,
schema requirements, or GitHub write boundaries. See
[Repository Prompt Additions](https://github.com/markhuangai/git-vibe/wiki/Configuration#repository-prompt-additions).

Current implementation status:

| Area                                                       | Status                      |
| ---------------------------------------------------------- | --------------------------- |
| Hosted GitHub App webhook mode                             | Implemented                 |
| Codex SDK and Claude Code SDK stage adapters               | Implemented                 |
| Source-built composite actions and reusable workflows      | Implemented                 |
| JSON Schema stage contracts                                | Implemented                 |
| Relay, Actions-native receiver, and polling delivery modes | Planned behind config shape |
| External GitHub mention partners                           | Planned opt-in surface      |

See the [GitVibe wiki](https://github.com/markhuangai/git-vibe/wiki) for the
canonical long-form documentation.

## Security Model

| Boundary      | Rule                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Webhooks      | The app verifies GitHub `x-hub-signature-256` before accepting events                             |
| Commands      | The server checks repository permission before protected actions                                  |
| Labels        | Public `git-vibe:` trigger labels are policy-gated; internal `gvi:` labels are GitVibe-managed    |
| Secrets       | App private keys and AI credentials stay in GitHub secrets or server runtime env, never in config |
| AI output     | Stage results are validated before deterministic GitVibe code writes GitHub state                 |
| Code writes   | GitVibe does not commit, push, or update repository files                                         |
| Pull requests | GitVibe reviews existing PRs, but humans author code, review, and merge                           |

Installation tokens are short-lived, repository-scoped, and minted from the
GitHub App private key. Never log or render App private keys, OIDC tokens, or
installation tokens.

## Architecture

GitVibe is one TypeScript package split by runtime boundary:

```text
src/
  app/       hosted GitHub App webhook server and repository orchestration
  runner/    action runtime, context assembly, prompts, schemas, AI execution
  shared/    GitHub helpers, labels, stage definitions, traceability types
```

The Docker image builds only app/shared output. Runner-only source, prompts, and
schemas are built by composite actions on the GitHub runner and do not trigger
app deployment unless shared, package, Docker, deploy, or app files change.

Detailed docs:

| Wiki page                                                                                         | Covers                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Architecture](https://github.com/markhuangai/git-vibe/wiki/Architecture)                         | System shape, GitHub App auth model, event delivery modes, consumer setup |
| [Workflows and Lifecycle](https://github.com/markhuangai/git-vibe/wiki/Workflows-and-Lifecycle)   | Issue, Discussion, label, approval, review, and traceability flows        |
| [AI and Stage Contracts](https://github.com/markhuangai/git-vibe/wiki/AI-and-Stage-Contracts)     | Context assembly, AI contracts, provider strategy, tool policy, budgets   |
| [Configuration](https://github.com/markhuangai/git-vibe/wiki/Configuration)                       | `.github/git-vibe.yml`, profiles, role groups, MCP, tests, budgets        |
| [Development and Testing](https://github.com/markhuangai/git-vibe/wiki/Development-and-Testing)   | Repo shape, quality gates, smoke tests, assumptions                       |
| [Security and Permissions](https://github.com/markhuangai/git-vibe/wiki/Security-and-Permissions) | GitHub App auth, trust boundaries, protected labels, SDK adapter risk     |

## Example action usage

```yaml
steps:
  - uses: actions/checkout@v7
    with:
      persist-credentials: false
  - uses: markhuangai/git-vibe/investigate@v3
    with:
      issue-number: "123"
```

## Example reusable workflow usage

```yaml
jobs:
  git-vibe-validate:
    uses: markhuangai/git-vibe/.github/workflows/validate.yml@v3
    with:
      issue-number: "123"
      runner: docker-runner
    secrets:
      GITVIBE_AI_ENV_JSON: ${{ secrets.GITVIBE_AI_ENV_JSON }}
      GITVIBE_MCP_ENV_JSON: ${{ secrets.GITVIBE_MCP_ENV_JSON }}
```

For source-repo testing, dispatch `investigate.yml`, `validate.yml`,
`materialize.yml`, or `review.yml` directly. Leave `action-repository` and
`action-ref` empty to test the current repository and ref.

## Development

Package manager:

```bash
corepack pnpm install --frozen-lockfile
```

Full local gate:

```bash
corepack pnpm check
```

Individual checks:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm build
corepack pnpm test
corepack pnpm coverage
corepack pnpm actionlint
corepack pnpm audit --prod
```

Quality thresholds:

```text
branches: 90%
functions: 90%
lines: 90%
statements: 90%
```

JavaScript/MJS limits:

```text
max file length: 700 lines
max function length: 100 lines
```
