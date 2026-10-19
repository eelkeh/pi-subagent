import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PROFILES, loadProfiles, parseProfiles, selectProfile, supportedThinking } from "../src/profiles.ts";
import { completedBranch, createChildSession } from "../src/context.ts";
import { forwardChildUi } from "../src/ui.ts";
import { presentOutcome } from "../src/results.ts";

const parent = { provider: "p", id: "parent", thinking: "high" as const };
const models = [{ provider: "p", id: "parent" }, { provider: "p", id: "cheap" }, { provider: "p", id: "strong" }];

test("task profiles choose model/thinking; explicit overrides take precedence; general inherits", () => {
  const profiles = { ...DEFAULT_PROFILES, explore: { description: "Search", model: "p/cheap", thinking: "low" as const } };
  assert.deepEqual(selectProfile(profiles, {}, parent, models), { provider: "p", modelId: "parent", thinking: "high", strictThinking: false });
  assert.deepEqual(selectProfile(profiles, { task_type: "explore" }, parent, models), { provider: "p", modelId: "cheap", thinking: "low", strictThinking: false });
  assert.deepEqual(selectProfile(profiles, { task_type: "explore", model: "strong", thinking: "high" }, parent, models), { provider: "p", modelId: "strong", thinking: "high", strictThinking: true });
  assert.equal(selectProfile(profiles, { task_type: "explore", model: "inherit" }, parent, models).modelId, "parent");
  assert.throws(() => selectProfile(profiles, { task_type: "missing" }, parent, models), /Unknown task_type/);
  assert.throws(() => selectProfile(profiles, { model: "missing" }, parent, models), /not available/);
  assert.throws(() => selectProfile(profiles, { model: "cheap" }, parent, [...models, { provider: "other", id: "cheap" }]), /ambiguous/);
  assert.throws(() => selectProfile(profiles, { task_type: "toString" }, parent, models), /Unknown/);
});

test("configuration validation rejects typos and invalid thinking", () => {
  for (const value of [null, [], {}, { profiles: [] }, { profiles: { bad: { thinking: "huge" } } }, { profiles: { bad: { modle: "cheap" } } }, { profiles: { bad: { model: "" } } }]) assert.throws(() => parseProfiles(value));
  assert.equal(parseProfiles({ profiles: { custom: { model: "p/strong" } } }).custom.model, "p/strong");
  assert.equal(supportedThinking("high", ["off"], false), "off");
  assert.equal(supportedThinking("max", ["off", "low", "high"], false), "high");
  assert.throws(() => supportedThinking("high", ["off"], true), /unsupported/);
});

test("global/project profiles merge only when project is trusted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-profiles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent"); const cwd = join(dir, "project");
  await mkdir(agent); await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(agent, "subagents.json"), JSON.stringify({ profiles: { explore: { model: "p/cheap", description: "Custom global description" } } }));
  await writeFile(join(cwd, ".pi/subagents.json"), JSON.stringify({ profiles: { explore: { thinking: "high" } } }));
  assert.equal((await loadProfiles(agent, cwd, false)).explore.thinking, "low");
  const trusted = await loadProfiles(agent, cwd, true);
  assert.equal(trusted.explore.model, "p/cheap"); assert.equal(trusted.explore.thinking, "high");
  assert.equal(trusted.explore.description, "Custom global description");
});

test("forks preserve active branch/compaction/edits, omit unfinished tool batch, and never mutate parent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-fork-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, "parent"));
  const first = manager.appendMessage({ role: "user", content: "visible sentinel", timestamp: 1 });
  manager.appendMessage({ role: "user", content: "abandoned secret", timestamp: 2 });
  manager.branch(first);
  manager.appendCustomMessageEntry("context", "active branch note", false);
  const compaction = manager.appendCompaction("summary sentinel", first, 100);
  const user = manager.appendMessage({ role: "user", content: "original", timestamp: 3 });
  manager.appendContextEdit(user, { content: "edited sentinel" });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "spawn-a", name: "agent_spawn", arguments: {} }, { type: "toolCall", id: "spawn-b", name: "agent_spawn", arguments: {} }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 4 });
  manager.appendMessage({ role: "toolResult", toolCallId: "spawn-a", toolName: "agent_spawn", content: [{ type: "text", text: "sibling result" }], isError: false, timestamp: 5 });
  const before = await readFile(manager.getSessionFile()!, "utf8");
  assert.ok(completedBranch(manager.getBranch()).some((entry) => entry.id === compaction));
  const path = await createChildSession({ cwd: dir, dir: join(dir, "children"), parentSession: manager.getSessionFile(), branch: manager.getBranch() });
  const child = SessionManager.open(path);
  const messages = JSON.stringify(child.buildSessionContext().messages);
  assert.match(messages, /summary sentinel/); assert.match(messages, /edited sentinel/);
  assert.doesNotMatch(messages, /abandoned secret|spawn-a|spawn-b|sibling result/);
  assert.equal(child.getHeader()?.parentSession, manager.getSessionFile());
  assert.equal(await readFile(manager.getSessionFile()!, "utf8"), before);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const fresh = SessionManager.open(await createChildSession({ cwd: dir, dir: join(dir, "children") }));
  assert.equal(fresh.buildSessionContext().messages.length, 0);
});

test("headless approval forwarding fails closed; interactive decisions are preserved", async () => {
  assert.deepEqual(await forwardChildUi({ hasUI: false, ui: {} as any }, "a", { method: "confirm" }), { cancelled: true });
  const titles: string[] = [];
  const ctx = { hasUI: true, ui: { confirm: async (title: string) => { titles.push(title); return false; }, input: async () => undefined } as any };
  assert.deepEqual(await forwardChildUi(ctx, "a", { method: "confirm", title: "Approve", message: "danger" }), { confirmed: false });
  assert.deepEqual(await forwardChildUi(ctx, "a", { method: "input" }), { cancelled: true });
  assert.equal(titles[0], "[a] Approve");
});

test("long output is capped with a private full-output artifact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-output-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const output = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const shown = await presentOutcome({ agent_id: "a", status: "completed", output, session_path: join(dir, "session.jsonl"), provider: "p", model: "m", thinking: "off", idle: false });
  assert.ok(shown.full_output_path); assert.ok(shown.output.length < output.length);
  assert.equal(await readFile(shown.full_output_path!, "utf8"), output);
  assert.equal((await stat(shown.full_output_path!)).mode & 0o777, 0o600);
});
