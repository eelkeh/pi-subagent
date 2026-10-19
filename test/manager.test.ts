import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentManager, type Outcome, type SpawnOptions } from "../src/manager.ts";
import type { RpcOptions, Transport, RecordMessage } from "../src/rpc.ts";

class FakeTransport implements Transport {
  readonly options: RpcOptions;
  requests: RecordMessage[] = [];
  writes: RecordMessage[] = [];
  stops = 0;
  promptAccepted = Promise.withResolvers<void>();
  constructor(options: RpcOptions) { this.options = options; }
  async request(command: RecordMessage) {
    this.requests.push(command);
    if (command.type === "get_available_thinking_levels") return { levels: ["off", "low", "medium", "high"] };
    if (command.type === "prompt") {
      this.promptAccepted.resolve();
      if (command.message.includes("FAST")) this.settle("fast answer");
      if (command.message.includes("HANDLED")) return { disposition: "handled" };
      return { disposition: "started" };
    }
    return {};
  }
  write(message: RecordMessage) { this.writes.push(message); }
  async stop() { this.stops++; }
  settle(text: string, stopReason = "stop") {
    this.options.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
    this.options.onEvent({ type: "agent_settled", aborted: false });
  }
}
const options = (extra: Partial<SpawnOptions> = {}): SpawnOptions => ({ prompt: "FAST", label: "Test", cwd: "/tmp", sessionPath: "/tmp/session.jsonl", selection: { provider: "p", modelId: "m", thinking: "high", strictThinking: false }, trusted: false, extensionPaths: [], ...extra });
function harness() {
  const clients: FakeTransport[] = [];
  const notifications: Outcome[] = [];
  const nextNotification = Promise.withResolvers<Outcome>();
  const nextMessage = Promise.withResolvers<string>();
  const manager = new AgentManager({
    createTransport: (opts) => { const client = new FakeTransport(opts); clients.push(client); return client; },
    notify: (outcome) => { notifications.push(outcome); nextNotification.resolve(outcome); },
    message: (_id, text) => nextMessage.resolve(text),
    ui: async () => ({ confirmed: false }),
  });
  return { manager, clients, notifications, nextNotification: nextNotification.promise, nextMessage: nextMessage.promise };
}

test("foreground catches immediate completion, tears down, and does not notify", async () => {
  const h = harness();
  const result = await h.manager.spawn(options());
  assert.equal(result.status, "completed"); assert.equal("output" in result && result.output, "fast answer");
  assert.equal(h.clients[0].stops, 1); assert.equal(h.notifications.length, 0);
  await assert.rejects(h.manager.send(result.agent_id, "follow-up"), /No live/);
});

test("persistent foreground agent wakes in same transport and reports follow-up completion", async () => {
  const h = harness();
  const result = await h.manager.spawn(options({ persistent: true }));
  assert.equal("idle" in result && result.idle, true); assert.equal(h.clients[0].stops, 0);
  await h.manager.send(result.agent_id, "FAST follow-up");
  assert.equal((await h.nextNotification).status, "completed");
  assert.equal(h.clients.length, 1); assert.equal(h.notifications.length, 1);
  await h.manager.stop(result.agent_id); assert.equal(h.clients[0].stops, 1);
});

test("background notifications are once-only and survive late spawning-tool abort", async () => {
  const h = harness(); const abort = new AbortController();
  const result = await h.manager.spawn(options({ prompt: "waiting", background: true }), abort.signal);
  assert.equal(result.status, "running");
  abort.abort(); assert.equal(h.clients[0].stops, 0);
  h.clients[0].settle("answer");
  assert.equal((await h.nextNotification).output, "answer");
  h.clients[0].settle("duplicate"); assert.equal(h.notifications.length, 1);
});

test("stop cancels foreground waits without sending a completion notification", async () => {
  const h = harness(); const abort = new AbortController();
  const pending = h.manager.spawn(options({ prompt: "waiting" }), abort.signal);
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.clients[0].stops, 1); assert.equal(h.notifications.length, 0);
});

test("timeout stops background work; explicit stop and session shutdown stay quiet", async () => {
  const h = harness();
  await h.manager.spawn(options({ prompt: "waiting", background: true, timeoutMs: 10 }));
  assert.equal((await h.nextNotification).status, "stopped");
  assert.match(h.notifications[0].output, /deadline/);
  const idle = await h.manager.spawn(options({ persistent: true }));
  await h.manager.stop(idle.agent_id);
  await h.manager.spawn(options({ persistent: true }));
  await h.manager.shutdown();
  assert.equal(h.notifications.length, 1);
  assert.ok(h.clients.every((client) => client.stops === 1));
  await assert.rejects(h.manager.spawn(options()), /cancelled/);
});

test("child messages and approval responses are relayed; wrong addresses fail", async () => {
  const h = harness();
  const child = await h.manager.spawn(options({ prompt: "waiting", background: true }));
  h.clients[0].options.onEvent({ type: "extension_ui_request", method: "setStatus", statusKey: "delphyr.subagent.message", statusText: "question" });
  assert.equal(await h.nextMessage, "question");
  h.clients[0].options.onEvent({ type: "extension_ui_request", method: "confirm", id: "dialog" });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(h.clients[0].writes, [{ type: "extension_ui_response", id: "dialog", confirmed: false }]);
  await assert.rejects(h.manager.send("@parent", "hello"), /No live/);
  await h.manager.stop(child.agent_id);
});

test("provider failures are not reported as success; unexpected exit settles work", async () => {
  const h = harness();
  await h.manager.spawn(options({ prompt: "waiting", background: true }));
  h.clients[0].settle("provider failed", "error");
  assert.equal((await h.nextNotification).status, "failed");
  const h2 = harness();
  await h2.manager.spawn(options({ prompt: "waiting", background: true }));
  h2.clients[0].options.onExit(new Error("crashed"));
  assert.equal((await h2.nextNotification).output, "crashed");
});

test("handled prompts finish without waiting for an event that will never arrive", async () => {
  const h = harness();
  assert.equal((await h.manager.spawn(options({ prompt: "HANDLED" }))).status, "completed");
});

test("parent cancellation stops an already-running foreground child", async () => {
  const h = harness(); const abort = new AbortController();
  const pending = h.manager.spawn(options({ prompt: "waiting" }), abort.signal);
  await h.clients[0].promptAccepted.promise;
  abort.abort();
  assert.equal((await pending).status, "stopped");
  assert.equal(h.clients[0].stops, 1);
  assert.equal(h.notifications.length, 0);
});

test("unsupported explicit thinking fails before prompting and cleans up the child", async () => {
  const h = harness();
  await assert.rejects(h.manager.spawn(options({ selection: { provider: "p", modelId: "m", thinking: "max", strictThinking: true } })), /unsupported/);
  assert.equal(h.clients[0].stops, 1);
  assert.equal(h.clients[0].requests.some((request) => request.type === "prompt"), false);
});

test("failed persistent follow-up notifies once and releases its process", async () => {
  const h = harness();
  const child = await h.manager.spawn(options({ persistent: true }));
  await h.manager.send(child.agent_id, "waiting");
  h.clients[0].settle("failed follow-up", "error");
  assert.equal((await h.nextNotification).status, "failed");
  assert.equal(h.clients[0].stops, 1);
  await assert.rejects(h.manager.send(child.agent_id, "again"), /No live/);
});

test("independent foreground spawns run concurrently without registry collisions", async () => {
  const h = harness();
  const results = await Promise.all([1, 2, 3].map(() => h.manager.spawn(options())));
  assert.equal(new Set(results.map((result) => result.agent_id)).size, 3);
  assert.equal(h.clients.length, 3);
  assert.ok(h.clients.every((client) => client.stops === 1));
});

test("background startup failure is returned once without a completion notification", async () => {
  const h = harness();
  const pending = h.manager.spawn(options({ prompt: "waiting", background: true }));
  h.clients[0].request = async () => { h.clients[0].options.onExit(new Error("startup crash")); throw new Error("startup crash"); };
  await assert.rejects(pending, /startup crash/);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.clients[0].stops, 1);
});

test("unexpected exit of an idle persistent agent notifies even after foreground completion", async () => {
  const h = harness(); const abort = new AbortController();
  const child = await h.manager.spawn(options({ persistent: true }), abort.signal);
  abort.abort(); // The spawning call no longer owns this resident's lifetime.
  assert.equal(h.clients[0].stops, 0);
  h.clients[0].options.onExit(new Error("idle crash"));
  assert.equal((await h.nextNotification).status, "failed");
  await assert.rejects(h.manager.send(child.agent_id, "again"), /No live/);
});

test("tool allowlist includes only explicit tools plus communication and disables unlisted MCP", async () => {
  const h = harness(); await h.manager.spawn(options({ tools: [] }));
  const args = h.clients[0].options.args;
  assert.equal(args[args.indexOf("--tools") + 1], "agent_send"); assert.ok(args.includes("--no-mcp"));
  assert.equal(args[args.indexOf("--exclude-tools") + 1], "agent_spawn,agent_stop");
  await assert.rejects(h.manager.spawn(options({ tools: ["+bash"] })), /plain tool/);
});
