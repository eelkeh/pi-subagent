# pi-subagent

A personal, MIT-licensed Pi extension, distributed through GitHub only (not npm).

A standalone Pi extension with three parent-side tools:

- **agent_spawn** — delegate a task, optionally in the background.
- **agent_send** — steer a running direct child or wake a persistent idle child.
- **agent_stop** — shut down a running or idle child.

Children expose only `agent_send(to="@parent")`; they cannot spawn descendants.
No scheduler, predefined agent personas, shared memory, or cross-tree routing.

## Install

Requires Node.js 22.19+ and Pi's current RPC/session interfaces (tested with Pi **1.3.0**).

Install directly from GitHub:

```sh
pi install git:github.com/eelkeh/pi-subagent
```

Restart Pi after installing. To try it for one invocation without saving the install:

```sh
pi -e git:github.com/eelkeh/pi-subagent
```

For local development:

```sh
git clone https://github.com/eelkeh/pi-subagent.git
cd pi-subagent
pnpm install --frozen-lockfile
pi -e ./src/index.ts
```

The package keeps `"private": true` to prevent accidental npm publication.

Do not enable another extension that registers the same three tool names.
Installation is not performed automatically by the tests.

## Tools

### agent_spawn

```json
{
  "prompt": "Inspect src/auth for token validation gaps. Do not edit. Return file/line references.",
  "label": "Auth reconnaissance",
  "task_type": "explore",
  "tools": ["read", "grep", "find", "ls"],
  "fork_context": false,
  "run_in_background": true,
  "persistent": true,
  "timeoutMs": 120000
}
```

Only `prompt` and `label` are required.

| Parameter | Default | Meaning |
|---|---|---|
| `task_type` | `general` | Task profile selecting model/thinking |
| `model` | profile, then parent | Exact `provider/modelId`, unambiguous exact ID, or `inherit` |
| `thinking` | profile, then parent | Explicit reasoning override |
| `fork_context` | `false` | Copy the completed active conversation branch |
| `persistent` | `false` | Keep child resident after successful completion |
| `run_in_background` | `false` | Return immediately; completion arrives as a follow-up |
| `tools` | normal child configuration | Tool allowlist; `agent_send` always included |
| `timeoutMs` | none | Per-run deadline, restarted on a persistent follow-up |

Foreground results contain the final output. Background starts return an `agent_id`;
a later `subagent-result` message contains output, status, actual model/thinking,
session path, and whether the child is idle/resident.

In Pi's interactive transcript, `subagent-result` notifications show a compact status
header and the answer as Markdown. JSON-only answers are pretty-printed and syntax
highlighted. Pi's expand action (Ctrl+O by default) switches to the complete,
pretty-printed JSON payload, including metadata. Truncated answers show the full-output
artifact path. Rendering does not change model-facing content or stored result data.

`tools: []` gives the child communication only. Allowlisting tools disables the built-in
MCP integration unless MCP tool names/patterns are explicitly included. Tool visibility
is **not** an OS sandbox; a permitted shell or another tool can access more resources.

### agent_send

```json
{ "to": "agent-1234abcd", "message": "Also check refresh-token expiry." }
```

While running, messages steer after the current assistant turn and its tools.
A persistent idle child wakes in the same process/session and later reports its answer.
Task profile/model/thinking stay fixed for the lifetime of that child.

A child sends progress or a question with:

```json
{ "to": "@parent", "message": "Do you want me to modify the migration too?" }
```

Upward delivery is best-effort, not an acknowledgement that the parent read or acted
on the message. Use background delegation for interactive back-and-forth; a parent
blocked on a foreground tool cannot immediately answer a child's question.

### agent_stop

```json
{ "agent_id": "agent-1234abcd" }
```

Intentional stops do not emit completion notifications. Transcripts are retained.

## Task-aware model selection

Create `~/.pi/agent/subagents.json` (or the equivalent under your configured Pi agent
directory). A **trusted** project's `.pi/subagents.json` can override individual profile
fields. Untrusted project profiles are not read.

Example — replace model IDs with models available in your Pi registry:

```json
{
  "profiles": {
    "explore": {
      "description": "Cheap, bounded searches and reconnaissance",
      "model": "your-provider/your-fast-model",
      "thinking": "low"
    },
    "implement": {
      "model": "your-provider/your-coding-model",
      "thinking": "medium"
    },
    "review": {
      "model": "your-provider/your-strong-model",
      "thinking": "high"
    },
    "reason": {
      "model": "inherit",
      "thinking": "high"
    },
    "quick_test": {
      "description": "Run a specific test and report its result",
      "model": "your-provider/your-fast-model",
      "thinking": "off"
    }
  }
}
```

Precedence is **explicit spawn override → selected task profile → current parent**.
The parent model chooses the task type based on the work; there is no additional
classifier call or hard-coded vendor preference.

Built-in profiles: `general` (inherit both), `explore` (low), `implement` (medium),
`review` (high), and `reason` (high). Models inherit until configured.
Profile/inherited reasoning is lowered to a supported level where necessary (e.g.
`off` for a non-reasoning model). An unsupported **explicit** thinking override fails.
Unknown models, ambiguous IDs, profile names, and invalid configuration fail rather
than silently selecting another model.

Configuration is reloaded for each spawn; profile descriptions are advertised when
the parent session starts. Existing children are unaffected by profile edits.

## Context and persistence

Fresh context is the default. `fork_context: true` writes a separate, private Pi
session using the parent's **active branch**, preserving compaction entries,
branch summaries, and context edits. It excludes the unfinished assistant tool-call
batch that spawned the child, including partial sibling results. Parent session
files are never modified. Forking is conversation inheritance, not a cache-hit
guarantee or a Git/workspace fork.

Child sessions live in `<agent-dir>/subagent-sessions/`; attach after completion with:

```sh
pi --session /path/from/the/result.jsonl
```

Persistent means **process residency until parent session shutdown**, not automatic
reconnection after a parent restart. Non-persistent children exit on completion.
Large final outputs are tail-capped at Pi's normal 2,000-line/50-KB limit and include
a path to a private full-output artifact.

## Runtime decision

Pi's SDK (`createAgentSession`) supports independent in-process sessions, native
tools, resource loaders, and session persistence. It avoids CLI startup overhead,
but shares process-level state and failure fate with the host.

This implementation uses **normal Pi CLI subprocesses over RPC** for independent
runtime/extension/model state and clean termination. It does not implement its own
agent loop. Each child loads normal Pi configuration and discovered extensions,
plus this extension and explicit file extensions inherited from the parent.
Inline SDK extension factories and ad hoc in-memory provider registrations cannot
cross the process boundary; make those file-based before delegating to them.
Project trust is explicitly preserved, not automatically granted.

Pi's exported `RpcClient` provides typed commands and emits raw UI records at runtime,
but has no public UI-response writer and its stop path uses signals. Our small transport
adds UI replies, readiness handshakes, bounded request waits, strict LF JSONL framing,
and stdin-EOF shutdown with process-group signal escalation on Unix. It does not
access private Pi APIs.

Child confirmation/input/select/editor requests are forwarded to the parent UI.
Headless parents cancel dialogs, never auto-approve. Child title/editor/widget/status
updates do not overwrite the parent UI.

## Lifecycle caveats

- Background work needs a long-lived parent (TUI/RPC). Print-mode parents exit and
  tear down children when their own run finishes.
- No default concurrency/token/deadline limits; spawn deliberately or supply a deadline.
- Parent cancellation stops a foreground child. Once a background spawn is accepted,
  a later cancellation of that spawning turn does not kill it; use `agent_stop`.
- Completion waits for `agent_settled`, not `agent_end`, so retries/steering finish first.
- Unix shutdown escalation targets the child's process group. Windows only guarantees
  termination of the direct child; descendant cleanup is not verified there.
- Children share the working directory/filesystem. There is no worktree or credential
  sandbox. Existing CLI-loaded safety extensions still apply, but transient parent-only
  runtime hook state is not cloned.
- Notifications are not durable acknowledgements. Session files survive, but there is
  no replay queue for a parent that exits before receiving a result.

## Tests

```sh
pnpm check
pnpm test
pnpm test:integration
```

Tests use temporary isolated Pi agent directories and a deterministic, test-only
provider. They never use production credentials or call a paid model.

Coverage includes routing/override precedence, config validation/project trust,
active-branch forks with compaction/context edits, process isolation, missing nested
tools, persistent PID/context reuse, foreground/background completion, bidirectional
messages, approval denial, deadlines, shutdown cleanup, startup/exit/protocol failures,
Unicode JSONL framing, response correlation, output truncation, and result rendering
(Markdown/JSON, expansion, replay, narrow widths, Unicode, padding and theme changes).

Protocol references: [RPC commands](https://pi.dev/docs/latest/rpc-commands),
[RPC extension UI](https://pi.dev/docs/latest/rpc-extension-ui),
[SDK](https://pi.dev/docs/latest/sdk), and
[session format](https://pi.dev/docs/latest/session-format).
