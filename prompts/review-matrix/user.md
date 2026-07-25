<stage_goal>
Review the proposed pull request or merge-preparation change. Report only validated issues that matter for correctness, tests, security, regressions, or maintainability.
</stage_goal>

<review_matrix>

- Correctness: Does the change satisfy the issue without introducing wrong behavior?
- Tests: Are meaningful affected paths covered? Are tests real rather than tautological?
- Security: Are permissions, tokens, user input, GitHub API writes, and secrets handled safely?
- Regression risk: Could existing workflows, compatibility paths, or consumers break?
- Maintainability: Is the change scoped, understandable, and consistent with existing patterns?
  </review_matrix>

<finding_standard>

- Validate each finding against the diff or code path before reporting it.
- Include file paths, commands, URLs, or schema fields that prove the issue.
- Do not report preferences, speculative improvements, over-engineering requests, or broad refactors as blockers.
- If required fixes exist, keep `status` as `completed`, set `next_state` to `changes-required`, and put only actionable required fixes in `findings`.
- For each required fix that can be anchored to an exact changed pull request diff line, add a matching `inline_comments` item with `path`, right-side `line`, and a concise `body` that explains the failure and required fix. Use `start_line` only for a contiguous range on the same side. For a range, `start_line` is the first line and must be less than or equal to `line`, which is the final line. Do not invent anchors; keep unanchored blockers in `findings` and `comment_body`.
- Each `inline_comments` item must have a unique `finding_id` within the output. Use one ranged comment for one finding when possible, or assign distinct IDs when multiple anchors are necessary.
- If an existing GitVibe inline review comment contains a hidden `git-vibe:review-finding id=...` marker and the same issue still applies, set the new `inline_comments` item `finding_id` to that id. Do not copy hidden markers into `body`, and do not reuse that ID for any other inline comment in the same output.
- If no required fix exists, say so in `summary`, keep `findings` empty, and set `next_state` to `review-passed`.
- Use `blocked` only when the review itself cannot be completed or a maintainer decision is required before code can continue.
  </finding_standard>

<required_fields_guidance>

- `tests`: Review-relevant checks observed or recommended.
- `findings`: Blocking issues only, ordered by severity.
- `inline_comments`: GitHub PR review comments for blocking findings that have exact changed-line anchors. Reuse `finding_id` from an existing GitVibe marker when reporting the same issue again. Leave empty or omit when there are no anchorable blockers.
- `questions`: Maintainer decisions required before code can continue, preferably as answerable question objects with up to four options.
- `next_state`: Use `review-passed` when the PR can proceed to approval, `changes-required` when implementation must address evidence-backed findings before the PR is ready for approval, or `blocked` when automation must stop.
  </required_fields_guidance>
