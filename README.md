# N2 Loom

Durable AI dialogue with genuine streaming, scoped memory and verified tool execution.

[한국어 설명](README.ko.md)

Loom turns one configured model provider into a conversational agent. Hecaton runs registered tools, N2R requires preparation and verification around the work, and Mimir stores experiences beside the shared Soul database. Conversation revisions, model turns and tool receipts survive process restarts.

## Install

Requires Node.js 22 or newer and a configured model endpoint.

```sh
npm install https://github.com/choihyunsus/n2-loom/releases/download/v1.0.0/n2-loom-1.0.0.tgz
```

This release is distributed through GitHub Releases. Source builds use `npm ci` followed by `npm run build`.

## Start a dialogue

Save this example as `dialogue.mjs`.

```js
import { Loom, ollamaChat } from 'n2-loom';

const loom = new Loom({
  dbPath: './data/mimir.db',
  project: 'demo',
  agent: 'assistant',
  limits: { contextBytes: 8192, maxOutputTokens: 512 },
  provider: ollamaChat({
    id: 'local',
    model: process.env.N2_LOOM_MODEL,
    think: false,
    contextLength: 8192,
  }),
});

try {
  const result = await loom.run(
    {
      runId: 'greeting-1',
      conversationId: 'desk',
      message: 'Say hello in one short sentence.',
      mode: 'chat',
    },
    {
      onEvent(event) {
        if (event.type === 'delta') process.stdout.write(event.data.text);
      },
    },
  );
  console.log(result.success, result.verification, result.experienceId);
} finally {
  await loom.close();
}
```

CommonJS consumers can use the same exports through `require('n2-loom')`. The configured Ollama model must already be installed. The default Ollama endpoint is `http://127.0.0.1:11434/api/chat`.

`agent` mode is the default and allows registered tools. `chat` mode requests text-only completion. Every mode passes through the required lifecycle.

## Providers and streaming

| Factory | Wire protocol | Visible text delivery |
|---|---|---|
| `openAIResponses` | Responses SSE | Incremental |
| `anthropicMessages` | Messages SSE | Incremental |
| `geminiInteractions` | Interactions SSE | Incremental |
| `openAICompatible` | Chat Completions SSE | Incremental |
| `ollamaChat` | Ollama NDJSON | Incremental in native tool mode |

Each factory requires an explicit `id` and `model`. Cloud factories accept `apiKey`. `endpoint` takes a complete API URL. Ollama also accepts `toolMode`, `contextLength` and `think`. JSON tool mode validates a complete envelope before emitting decoded text and reports `textStreaming: false`.

Match `limits.contextBytes` and `maxOutputTokens` to the model server's context window. The context limit measures serialized bytes. Custom providers call `request.onAttempt()` before each upstream attempt so retry accounting stays accurate.

The adapters preserve provider-native continuation data, including function-call IDs and opaque reasoning state. Visible events contain the public text stream. A custom Gumiho `ModelProvider` can supply buffered generation, or implement `StreamingProvider` with `stream(request, onText)` and an explicit `textStreaming` flag. Class-based callbacks retain their receiver.

HTTP transport applies UTF-8 validation, frame and response bounds, deadlines and cancellation. Eligible 429/503 responses can retry before stream consumption. A partially received response leaves a resumable model attempt with its budget reservation retained.

## Tools and verification

Supply Hecaton tool definitions through `tools`. Every definition has a stable name and version, an input schema and an execution callback. Loom selects a small schema set for the prompt. The read-only `loom_discover` tool searches the full registered catalog, and Hecaton validates every requested call.

Tools execute in the order requested by the model. Hecaton enforces the host policy and records intent before an effect. For MCP tools, first import the approved bindings with Hecaton using the same database, project and agent. Start Loom with the matching `mcpServers` configuration.

Remote tools enforce their own argument-level data scope. For a shared Soul server, bind each tool's `project` and `agent` arguments to the intended scope in the host policy. `mcpServers()` reports connection state and owned stdio process IDs.

An optional versioned `confirmation.request(context)` hook approves mutating tool calls. Its immutable request includes the full arguments, tool definition, request ID, deadline and abort signal. The default confirmation deadline is 60 seconds.

The default verification checks protocol completion and recorded tool outcomes. Its result is labelled `kind: 'protocol'`. A versioned `verifier.verify(context)` hook checks application-specific outcomes and records `kind: 'host'`, a summary and optional evidence. Failed tool calls require host verification for an eventual successful result. `preparation.prepare(context)` supplies an optional application precondition check. Preparation and verification callbacks perform repeatable checks.

## Durable execution

- Use a new `runId` for a new task. Retry an interrupted task with the same ID, input, callback versions and configuration.
- Completed runs return their immutable receipt with `cached: true`.
- Pending model attempts can retry within the cumulative request and output budgets.
- A tool effect with an uncertain outcome exposes its Hecaton request ID. Inspect `toolStatus(id)`, verify the actual external outcome, and call `reconcileTool(id, result, evidence)` before resuming.
- A newer task reserves a new conversation revision. A stale interrupted task is fenced from overwriting that conversation.
- Final results, the shared experience, conversation history, checkpoint and terminal events commit together.

Use `status(runId)`, `history(limit, offset)`, `conversation(id)` and `events(runId, afterSequence, limit)` to inspect progress. `cancel(runId)` targets the active run. `close()` cancels active work and closes owned connections.

Events have durable sequence numbers. Set `afterSequence` when reconnecting. Replayed events carry `replay: true`. Group text deltas by their `turn` and `attempt` fields when replacing a partial model attempt. The final result contains the accepted full output and an explicit `error` for unsuccessful completion.

Long contexts are shortened into source-labelled excerpts with links to the full recorded evidence. These handoffs retain cumulative budgets. Conversation history retains bounded user/assistant text across separate tasks. Exact provider-native tool continuation is retained within each durable run.

## Shared Soul storage

Use the same SQLite file and explicit `project`/`agent` values as the other modules. Loom uses Mimir's common experiences and adds seven scoped tables.

```text
loom_conversations  loom_runs        loom_models
loom_tools          loom_events      loom_checkpoints
loom_leases
```

Module schema version 1 is stored in `meta`. Records carry integrity hashes and bounded JSON. Existing partial or incompatible Loom schemas require explicit migration. Soul checkpoints and other modules retain their own record ownership.

The Mimir Rust backend and its better-sqlite3 fallback share the storage contract. Application-level learning reuses scoped experiences, history and checkpoints. The model host manages model weights and fine-tuning.

One logical workflow owns a project/agent scope at a time. Schedule Loom and Gumiho workflows sequentially for the same scope. Loom's provider adapters also implement Gumiho's provider contract for use in its tails.

## Budgets

| Budget | Default |
|---|---|
| Model turns / HTTP attempts / tool calls | 50 / 64 / 128 |
| Failed tool calls / context generations | 5 / 10 |
| Output tokens per request / total reserved | 2,048 / 131,072 |
| Model context | 96,000 serialized bytes |
| Model request / overall execution window | 120 seconds / 1 hour |
| Observer / confirmation deadline | 30 / 60 seconds |
| Event count / event payload | 32,768 / 8 MiB |
| Trace payload budget | 32 MiB |

Set `limits` to configure supported bounds. Request, tool and output reservations persist across retries. The execution window starts at run creation. A completed tool receipt can still be reconciled into the dialogue after that window, while further model and effect execution is stopped.

Inputs support a 64 KiB message, 16 KiB system prompt and up to 200 history entries within 1 MiB. Final visible output is bounded at 128 KiB. The changed-file summary is bounded at 1,024 paths and 64 KiB, with complete per-call reports retained in tool receipts. Payload budgets cover serialized records. The host controls database retention and OS-level resource limits.

## CLI and MCP

```sh
n2-loom run --db ./data/mimir.db --project demo --agent assistant \
  --provider ollama --model YOUR_INSTALLED_MODEL \
  --run-id greeting-1 --conversation-id desk --message "Hello" --stream

n2-loom status --db ./data/mimir.db --project demo --agent assistant --run-id greeting-1
n2-loom help
```

`--stream` emits newline-delimited event objects followed by a result object. A failed completed task exits with a failure status. Inspection commands use read-only connections to existing storage. `--request file.json` supplies a complete request. Request and limits files accept UTF-8 with an optional BOM.

`--host trusted-local.cjs` loads explicitly configured JavaScript callbacks. See `examples/host.cjs` for a local provider and a read-only word-count tool. Set `N2_LOOM_MODEL` before using that example. CLI cloud credentials use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`.

```sh
n2-loom mcp --db ./data/mimir.db --project demo --agent assistant --host ./host.cjs
```

The MCP interface exposes ten tools.

```text
loom_run           loom_cancel        loom_status
loom_read          loom_events        loom_history
loom_conversation  loom_tools         loom_tool_status
loom_reconcile
```

Responses use bounded previews. `loom_read` returns full records in Unicode-character chunks with a SHA-256 value to compare across pages. MCP scope is fixed by the launching host. The stdio transport bounds frames, message rate and pending output. Stalled output writes expire after five seconds. The CLI closes its owned work before terminating a process retained by a blocked native write.

## Host responsibilities

The host supplies credentials, tool authorization, application-specific verification, UI and operating-system isolation. Callbacks receive abort signals. Callbacks that ignore cancellation can continue in their host environment, so hard termination and CPU/memory enforcement belong in host-owned workers or processes. A verification receipt describes the checks performed and their evidence.

## Validation

```sh
npm ci
npm test
npm run typecheck:consumer
npm audit --omit=dev --audit-level=low
npm pack --dry-run
```

The suite covers all five streaming protocols over loopback HTTP, ordered tool execution, native file verification, cancellation, restart, context handoffs, shared storage, commit failures, explicit reconciliation, CLI, MCP and stalled output. Cloud-adapter validation uses deterministic protocol fixtures. Installed-consumer checks exercise CommonJS and ES modules with strict declaration checking.

A CPU-only Gemma4 4.6B Q4_K_M smoke run used two model requests and one registered read, returned the correct word count, and replayed from storage. It used two CPU threads, an 8,192-token model context, a 512-token output allowance and temperature zero. An earlier 128-token run stopped as incomplete. A separate generation requested two identical reads with distinct tool-call IDs. Execution receipts and replay protection apply to individual requests, while the host verifier checks the task outcome.

## License

Loom source uses MIT. Mimir and Clotho retain their published non-commercial/commercial terms, including a separate commercial license requirement for the uses specified in those files. Review the bundled license files and `THIRD-PARTY-NOTICES` when choosing a distribution or commercial deployment model.
