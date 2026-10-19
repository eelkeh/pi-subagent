import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProcess, type RecordMessage } from "../src/rpc.ts";

const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-integration-"));
  const agentDir = join(dir, "agent"); await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [provider], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { mode: "off" } }));
  await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ profiles: { explore: { model: "subagent-test/cheap", thinking: "low" }, review: { model: "subagent-test/strong", thinking: "high" } } }));
  const events: RecordMessage[] = [];
  const watchers = new Set<() => void>();
  const rpc = new RpcProcess({ cwd: dir, args: ["--offline", "--provider", "subagent-test", "--model", "parent", "--thinking", "high", "--extension", extension, "--session-dir", join(dir, "sessions"), "--no-skills", "--no-mcp", "--no-context-files"], env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, onEvent: (event) => { events.push(event); for (const watcher of watchers) watcher(); }, onExit: () => {} });
  t.after(async () => { await rpc.stop(); await rm(dir, { recursive: true, force: true }); });
  await rpc.request({ type: "get_state" });
  const wait = (predicate: (event: RecordMessage) => boolean, from = 0): Promise<RecordMessage> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watchers.delete(check); reject(new Error(`Missing event; recent events: ${JSON.stringify(events.slice(-5))}`)); }, 20_000);
    const check = () => { const found = events.slice(from).find(predicate); if (found) { clearTimeout(timer); watchers.delete(check); resolve(found); } };
    watchers.add(check); check();
  });
  const run = async (command: string, args?: unknown) => {
    const start = events.length;
    await rpc.request({ type: "prompt", message: args === undefined ? command : `${command}:${JSON.stringify(args)}`, streamingBehavior: "followUp" });
    if (args === undefined) { await wait((event) => event.type === "agent_settled", start); return undefined; }
    const toolName = { SPAWN: "agent_spawn", SEND: "agent_send", STOP: "agent_stop" }[command];
    const tool = await wait((event) => event.type === "tool_execution_end" && event.toolName === toolName, start);
    await wait((event) => event.type === "agent_settled", events.indexOf(tool));
    const text = tool.result?.content?.find((block: RecordMessage) => block.type === "text")?.text;
    if (tool.isError || tool.result?.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const notification = async (from: number, id?: string) => {
    const event = await wait((event) => event.type === "message_end" && event.message?.customType === "subagent-result" && (!id || JSON.parse(event.message.content).agent_id === id), from);
    return JSON.parse(event.message.content);
  };
  return { dir, agentDir, rpc, events, wait, run, notification };
}

test("real Pi: task routing, independent process, no nested tools, persistence and stop", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const first = await h.run("SPAWN", { prompt: "INSPECT", label: "Recon", task_type: "explore", persistent: true, tools: [] });
  assert.equal(first.usage.totalTokens, 2);
  assert.equal(first.status, "completed"); assert.equal(first.model, "cheap"); assert.equal(first.thinking, "off"); assert.equal(first.idle, true);
  const inspected = JSON.parse(first.output);
  assert.notEqual(inspected.pid, h.rpc.process.pid);
  assert.deepEqual(inspected.tools, ["agent_send"]);
  assert.equal(inspected.model, "cheap");
  const before = h.events.length;
  await h.run("SEND", { to: first.agent_id, message: "INSPECT" });
  const followup = await h.notification(before, first.agent_id);
  const inspectedAgain = JSON.parse(followup.output);
  assert.equal(inspectedAgain.pid, inspected.pid); assert.equal(followup.idle, true);
  assert.ok(inspectedAgain.userMessages > inspected.userMessages);
  assert.equal((await h.run("STOP", { agent_id: first.agent_id })).status, "stopped");
  assert.ok((await readFile(first.session_path, "utf8")).includes("INSPECT"));
  const override = await h.run("SPAWN", { prompt: "INSPECT", label: "Override", task_type: "explore", model: "subagent-test/strong", thinking: "high" });
  assert.equal(override.model, "strong"); assert.equal(override.thinking, "high");
  assert.equal(JSON.parse(override.output).tools.includes("agent_spawn"), false);
  assert.throws(() => process.kill(inspected.pid, 0), /ESRCH/);
});

test("real Pi: context off by default; opt-in fork inherits active history", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  await h.run("CONTEXT_SENTINEL");
  const fresh = await h.run("SPAWN", { prompt: "INSPECT", label: "Fresh", tools: [] });
  assert.equal(JSON.parse(fresh.output).hasSentinel, false);
  assert.equal(fresh.model, "parent"); assert.equal(fresh.thinking, "high");
  const fork = await h.run("SPAWN", { prompt: "INSPECT", label: "Fork", fork_context: true, tools: [] });
  assert.equal(JSON.parse(fork.output).hasSentinel, true);
  const forkText = await readFile(fork.session_path, "utf8");
  assert.match(forkText, /CONTEXT_SENTINEL/);
  // Exactly two historical completed spawns; no unfinished third spawning batch copied.
  const entries = forkText.trim().split("\n").map((line) => JSON.parse(line));
  const calls = entries.flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content.filter((block: RecordMessage) => block.type === "toolCall" && block.name === "agent_spawn") : []);
  assert.equal(calls.length, 1); // the previous, completed fresh spawn
});

test("real Pi: child-to-parent messaging and denial of child approval requests", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const start = h.events.length;
  const send = await h.run("SPAWN", { prompt: "SEND_PARENT", label: "Communicator", tools: [] });
  assert.equal(send.status, "completed");
  const message = await h.wait((event) => event.type === "message_end" && event.message?.customType === "subagent-message", start);
  assert.equal(JSON.parse(message.message.content).message, "child progress sentinel");
  const approval = h.wait((event) => event.type === "extension_ui_request" && event.method === "confirm", h.events.length);
  const task = h.run("SPAWN", { prompt: "ASK_APPROVAL", label: "Approval" });
  const dialog = await approval;
  assert.match(dialog.title, /agent-/);
  h.rpc.write({ type: "extension_ui_response", id: dialog.id, confirmed: false });
  assert.equal(JSON.parse((await task).output).approved, false);
});

test("real Pi: background completion and deadline; parent shutdown kills resident children", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const start = h.events.length;
  const running = await h.run("SPAWN", { prompt: "INSPECT", label: "Background", run_in_background: true, task_type: "review" });
  assert.equal(running.status, "running");
  const complete = await h.notification(start, running.agent_id);
  assert.equal(complete.status, "completed"); assert.equal(complete.model, "strong");
  const deadlineStart = h.events.length;
  const hanging = await h.run("SPAWN", { prompt: "HANG", label: "Deadline", run_in_background: true, timeoutMs: 100 });
  const timedOut = await h.notification(deadlineStart, hanging.agent_id);
  assert.equal(timedOut.status, "stopped"); assert.match(timedOut.output, /deadline/);
  const resident = await h.run("SPAWN", { prompt: "INSPECT", label: "Resident", persistent: true });
  const pid = JSON.parse(resident.output).pid;
  await h.rpc.stop();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("real Pi: provider failure is surfaced, invalid model override never falls back", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run("SPAWN", { prompt: "FAIL", label: "Failure" }), /deterministic provider failure/);
  await assert.rejects(h.run("SPAWN", { prompt: "INSPECT", label: "Invalid", model: "subagent-test/not-a-model" }), /not available/);
  await assert.rejects(h.run("SPAWN", { prompt: "INSPECT", label: "Unsupported thinking", model: "subagent-test/cheap", thinking: "high" }), /unsupported/);
});
