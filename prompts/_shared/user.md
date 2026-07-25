<context_package>
{{github_context}}

{{repository_context}}
</context_package>

<execution_contract>
{{stage_contract}}
</execution_contract>

<required_output>
{{output_schema}}
</required_output>

<required_process>

1. Identify the GitHub artifact, requested outcome, and any labels or comments that affect authorization.
2. Inspect `github_context.context_manifest` first. If `github_context.context_files` exists, search its compact JSONL `index.path` to identify relevant context units before reading their contents.
3. Each index row's `file` is relative to the directory containing `index.path`. Use read or grep tools with bounded ranges against selected unit files; do not read every unit by default.
4. The detailed `manifest.path` contains hashes and complete metadata. Read it only when those details are necessary. Do not read the full serialized context by default.
5. If `github_context.context_files` is absent, `included_context_chunks` contains the chunk text supplied within the prompt budget and `pending_chunks` are listed by id but not semantically processed.
6. Do not return `blocked` solely for omitted inline chunks or file-backed context references. Use tools when missing content is material to the decision; otherwise state the context limit in assumptions or findings.
7. Read or inspect only the context needed for this stage. Use tools when the supplied context metadata is not enough to support the conclusion.
8. Separate facts, assumptions, questions, and risks. Do not merge them into vague prose.
9. Decide whether the stage is `completed` or `blocked`. If blocked, explain the blocking condition and do not trigger downstream work through a completed status.
10. Build the final JSON object with every required field from the schema. Include optional fields only when they are useful and schema-valid.
11. Return only the final JSON object.
    </required_process>

<status_rules>

- Use `completed` when the output is actionable and safe for deterministic GitVibe code to continue.
- Use `blocked` when required context, authority, branch state, tests, or human decisions are missing.
- Do not use `completed` to be polite. Downstream writes may happen only for completed results.
  </status_rules>

<json_rules>

- Return one JSON object and nothing else.
- Do not include Markdown fences.
- Do not include comments or trailing commas.
- Use arrays for array fields, even when empty.
- Use concise strings. Prefer paths, URLs, commands, and concrete facts over generic descriptions.
- For `questions` and `blocking_questions`, use objects like `{"question":"Which scope should be implemented?","options":["Only the current issue","All linked issues","Open a follow-up issue"]}` when options are useful. Use at most four options, do not include a generic "other" option, and group questions so a maintainer can answer in one reply.
  </json_rules>
