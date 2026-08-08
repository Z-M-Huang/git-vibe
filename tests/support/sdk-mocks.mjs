// @ts-nocheck
import { beforeEach, vi } from "vitest";

const codexConstructor = vi.fn(function Codex() {
  return {
    startThread: codexStartThread,
  };
});
const codexStartThread = vi.fn((options = {}) => ({
  runStreamed: async (input, turnOptions = {}) => {
    const result = await codexRun(input, turnOptions, options);
    return result?.events ? result : { events: codexEvents(result) };
  },
}));
const codexRun = vi.fn(async (_input, turnOptions = {}) => {
  if (codexResultQueues.length > 0) return codexResultQueues.shift();

  const output = nextOutput("codex", turnOptions.outputSchema);
  return {
    finalResponse: JSON.stringify(output),
    items: [{ id: "message", text: JSON.stringify(output), type: "agent_message" }],
    usage: {
      cached_input_tokens: 0,
      input_tokens: 10,
      output_tokens: 10,
      reasoning_output_tokens: 0,
    },
  };
});

const claudeQuery = vi.fn((params) => claudeMessages(params));

vi.mock("@openai/codex-sdk", () => ({
  Codex: codexConstructor,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeQuery,
}));

globalThis.__gitVibeSdkMocks = {
  claudeQuery,
  codexConstructor,
  codexRun,
  codexStartThread,
  queueClaudeMessages: (messages) => queueMessages("claude", messages),
  queueClaudeOutput: (output) => queueOutput("claude", output),
  queueCodexResult: (result) => codexResultQueues.push(result),
  queueCodexOutput: (output) => queueOutput("codex", output),
  resetSdkMocks,
};

beforeEach(() => {
  resetSdkMocks();
});

async function* claudeMessages(params) {
  if (claudeMessageQueues.length > 0) {
    const queuedMessages = claudeMessageQueues.shift();
    for (const message of queuedMessages) yield message;
    return;
  }

  const output = nextOutput("claude", params?.options?.outputFormat?.schema);
  yield {
    claude_code_version: "test",
    cwd: params?.options?.cwd || process.cwd(),
    mcp_servers: [],
    model: params?.options?.model || "opus",
    output_style: "default",
    permissionMode: params?.options?.permissionMode || "bypassPermissions",
    plugins: [],
    session_id: "session",
    skills: [],
    slash_commands: [],
    subtype: "init",
    tools: [],
    type: "system",
    uuid: "init",
  };
  yield {
    duration_api_ms: 1,
    duration_ms: 1,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: JSON.stringify(output),
    session_id: "session",
    stop_reason: "stop",
    structured_output: output,
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {},
    uuid: "result",
  };
}

async function* codexEvents(result) {
  yield { thread_id: "thread", type: "thread.started" };
  yield { type: "turn.started" };
  let finalResponseSeen = false;
  for (const item of result.items || []) {
    if (item.type === "agent_message" && item.text === result.finalResponse) {
      finalResponseSeen = true;
    }
    yield { item, type: "item.completed" };
  }
  if (!finalResponseSeen) {
    yield {
      item: { id: "final-response", text: result.finalResponse, type: "agent_message" },
      type: "item.completed",
    };
  }
  if (result.usage) yield { type: "turn.completed", usage: result.usage };
}

function queueOutput(adapter, output) {
  outputQueues[adapter].push(output);
}

function queueMessages(adapter, messages) {
  if (adapter === "claude") claudeMessageQueues.push(messages);
}

function nextOutput(adapter, schema) {
  if (outputQueues[adapter].length > 0) return outputQueues[adapter].shift();
  return defaultOutputForSchema(schema);
}

function resetSdkMocks() {
  outputQueues.codex = [];
  outputQueues.claude = [];
  codexResultQueues.length = 0;
  claudeMessageQueues.length = 0;
  codexConstructor.mockClear();
  codexStartThread.mockClear();
  codexRun.mockClear();
  claudeQuery.mockClear();
}

const outputQueues = {
  claude: [],
  codex: [],
};
const codexResultQueues = [];
const claudeMessageQueues = [];

function defaultOutputForSchema(schema) {
  const schemaId = schema && typeof schema === "object" ? schema.$id : undefined;
  if (schemaId === "investigate.v1") return investigateOutput();
  if (schemaId === "materialize.v2") return materializeOutput();
  if (schemaId === "review-matrix.v1") return reviewMatrixOutput();
  if (schemaId === "validate.v1") return validateOutput();
  throw new Error(`No default SDK mock output configured for schema id: ${String(schemaId)}`);
}

function investigateOutput() {
  return {
    assumptions: [],
    blocking_questions: [],
    comment_body: "Ready to implement.",
    findings: [],
    next_state: "ready-for-implementation",
    references: [],
    stage: "investigate",
    status: "completed",
    summary: "Ready.",
  };
}

function validateOutput() {
  return {
    assumptions: [],
    comment_body: "Ready for approval.",
    findings: ["Implementation scope is clear."],
    next_state: "ready-for-implementation",
    references: [],
    stage: "validate",
    status: "completed",
    summary: "Ready.",
  };
}

function materializeOutput() {
  return {
    assumptions: [],
    comment_body: "Created issue.",
    findings: [],
    issues: [
      {
        acceptance_criteria: ["Issue is created."],
        background: "Implementation body.",
        backpressure_commands: ["corepack pnpm test"],
        blocked_by: [],
        parallel_group: "default",
        requirements: ["Implement feature."],
        review_guidelines: ["Verify behavior."],
        title: "Implement feature",
      },
    ],
    next_state: "implementation-issues-ready",
    references: [],
    stage: "materialize",
    status: "completed",
    summary: "Materialized.",
  };
}

function reviewMatrixOutput() {
  return {
    assumptions: [],
    comment_body: "Review passed.",
    findings: [],
    next_state: "review-passed",
    references: [],
    stage: "review-matrix",
    status: "completed",
    summary: "Reviewed.",
  };
}
