import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { supportedThinking, type Selection, type Thinking } from "./profiles.ts";
import { RpcProcess, type RpcOptions, type RecordMessage, type Transport } from "./rpc.ts";

export const CHILD_ID_ENV = "DELPHYR_PI_SUBAGENT_ID";
export const MESSAGE_KEY = "delphyr.subagent.message";
export interface Outcome {
  agent_id: string;
  status: "completed" | "failed" | "stopped";
  output: string;
  session_path: string;
  provider: string;
  model: string;
  thinking: Thinking;
  idle: boolean;
  usage?: Usage;
}
export interface SpawnOptions {
  prompt: string;
  label: string;
  cwd: string;
  sessionPath: string;
  selection: Selection;
  extensionPaths: string[];
  tools?: string[];
  trusted: boolean;
  persistent?: boolean;
  background?: boolean;
  timeoutMs?: number;
}
interface Run {
  resolve(outcome: Outcome): void;
  done: Promise<Outcome>;
  notify: boolean;
  output: string;
  usage?: Usage;
  error?: string;
}
interface Child {
  id: string;
  options: SpawnOptions;
  client: Transport;
  state: "starting" | "running" | "idle" | "closed";
  run: Run;
  operations: Promise<unknown>;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  thinking: Thinking;
}
interface ManagerOptions {
  createTransport?: (options: RpcOptions) => Transport;
  notify(outcome: Outcome): void | Promise<void>;
  message(agentId: string, message: string): void;
  ui(agentId: string, event: RecordMessage): Promise<RecordMessage | undefined>;
}

function newRun(notify: boolean): Run {
  let resolve!: Run["resolve"];
  const done = new Promise<Outcome>((complete) => { resolve = complete; });
  return { done, resolve, notify, output: "" };
}

/** Session-scoped direct-child registry. Command acceptance and completion transitions are serialized. */
export class AgentManager {
  private readonly children = new Map<string, Child>();
  private closed = false;
  private readonly deps: ManagerOptions;
  constructor(deps: ManagerOptions) { this.deps = deps; }

  async spawn(options: SpawnOptions, signal?: AbortSignal): Promise<Outcome | { agent_id: string; status: "running"; session_path: string; provider: string; model: string; thinking: Thinking }> {
    if (this.closed || signal?.aborted) throw new Error("Agent spawn cancelled");
    const id = `agent-${randomUUID().slice(0, 8)}`;
    const args = ["--session", options.sessionPath, "--provider", options.selection.provider, "--model", options.selection.modelId,
      "--name", options.label.slice(0, 80), "--exclude-tools", "agent_spawn,agent_stop", options.trusted ? "--approve" : "--no-approve"];
    for (const path of new Set(options.extensionPaths)) args.push("--extension", path);
    if (options.tools) {
      if (options.tools.some((tool) => !tool.trim() || /^[+-]/.test(tool) || tool.includes(","))) throw new Error("tools must contain plain tool names/patterns, not selection modifiers");
      args.push("--tools", [...new Set([...options.tools, "agent_send"])].join(","));
      // A tool allowlist is not a sandbox. Do not leave unlisted MCP tools callable via codemode.
      if (!options.tools.some((tool) => tool.startsWith("mcp__"))) args.push("--no-mcp");
    }
    const run = newRun(false); // A failed startup is reported by the tool, not a second notification.
    // The transport must not emit synchronously from its constructor (real child I/O is asynchronous).
    const client = (this.deps.createTransport ?? ((opts) => new RpcProcess(opts)))({
      cwd: options.cwd, args, env: { [CHILD_ID_ENV]: id },
      onEvent: (event) => this.event(id, event),
      onExit: (error) => { const child = this.children.get(id); if (child) void this.terminate(child, "failed", error.message, true).catch(() => {}); },
    });
    const child: Child = { id, options, client, run, state: "starting", operations: Promise.resolve(), thinking: options.selection.thinking };
    this.children.set(id, child);
    const abort = () => {
      if (child.state === "starting" || child.state === "running") void this.terminate(child, "stopped", "Cancelled by parent", false).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.enqueue(child, async () => {
        await client.request({ type: "get_state" }); // readiness handshake, never a startup sleep
        const { levels } = await client.request({ type: "get_available_thinking_levels" });
        child.thinking = supportedThinking(options.selection.thinking, levels, options.selection.strictThinking);
        await client.request({ type: "set_thinking_level", level: child.thinking });
        if (child.state === "closed") throw new Error("Agent spawn cancelled");
        child.state = "running";
        this.armTimeout(child);
        const accepted = await client.request({ type: "prompt", message: this.taskPrompt(id, options.prompt) });
        run.notify = options.background ?? false;
        if (accepted.disposition === "handled") this.scheduleFinish(child, false);
      });
      if (options.background) {
        // Once accepted, background lifetime is independent from the spawning tool's signal.
        return { agent_id: id, status: "running", session_path: options.sessionPath, provider: options.selection.provider, model: options.selection.modelId, thinking: child.thinking };
      }
      return await run.done;
    } catch (error) {
      await this.terminate(child, "failed", error instanceof Error ? error.message : String(error), false);
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }

  async send(to: string, message: string): Promise<{ agent_id: string; delivered: true }> {
    const id = to.startsWith("@") ? to.slice(1) : to;
    const child = this.children.get(id);
    if (!child || child.state === "closed") throw new Error(`No live direct child: ${to}`);
    if (!message.trim()) throw new Error("Message must not be empty");
    await this.enqueue(child, async () => {
      if (child.state === "closed") throw new Error(`No live direct child: ${to}`);
      if (child.state === "idle") {
        child.run = newRun(true);
        child.state = "running";
        this.armTimeout(child);
      }
      const accepted = await child.client.request({ type: "prompt", message: `[from @parent] ${message}`, streamingBehavior: "steer" });
      if (accepted.disposition === "handled") this.scheduleFinish(child, false);
    }).catch(async (error) => {
      await this.terminate(child, "failed", String(error), true);
      throw error;
    });
    return { agent_id: id, delivered: true };
  }

  async stop(id: string): Promise<void> {
    const child = this.children.get(id.replace(/^@/, ""));
    if (!child) throw new Error(`No live direct child: ${id}`);
    await this.terminate(child, "stopped", "Stopped by parent", false);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.children.values()].map((child) => this.terminate(child, "stopped", "Parent session ended", false)));
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Could not stop all subagents");
  }

  private enqueue<T>(child: Child, operation: () => Promise<T>): Promise<T> {
    const result = child.operations.then(operation);
    child.operations = result.catch(() => {});
    return result;
  }

  private event(id: string, event: RecordMessage): void {
    const child = this.children.get(id);
    if (!child || child.state === "closed") return;
    if (event.type === "message_end" && event.message?.usage) {
      const usage: Usage = event.message.usage;
      if (!child.run.usage) child.run.usage = structuredClone(usage);
      else {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) child.run.usage[key] += usage[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) child.run.usage.cost[key] += usage.cost[key];
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      child.run.output = (message.content ?? []).filter((block: RecordMessage) => block.type === "text").map((block: RecordMessage) => block.text).join("\n");
      child.run.error = message.stopReason === "error" || message.stopReason === "length" ? message.errorMessage ?? `Assistant stopped: ${message.stopReason}` : undefined;
    }
    if (event.type === "agent_settled") this.scheduleFinish(child, event.aborted === true);
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus" && event.statusKey === MESSAGE_KEY) {
        if (typeof event.statusText === "string") this.deps.message(id, event.statusText);
      } else {
        void this.deps.ui(id, event).then((response) => {
          if (response && child.state !== "closed") child.client.write({ type: "extension_ui_response", id: event.id, ...response });
        }).catch(() => {
          if (child.state !== "closed") { try { child.client.write({ type: "extension_ui_response", id: event.id, cancelled: true }); } catch {} }
        });
      }
    }
  }

  private scheduleFinish(child: Child, aborted: boolean): void {
    void this.enqueue(child, () => this.finish(child, aborted)).catch((error) => this.terminate(child, "failed", String(error), true)).catch(() => {});
  }

  private async finish(child: Child, aborted: boolean): Promise<void> {
    if (child.state !== "running") return;
    clearTimeout(child.timer);
    const run = child.run;
    const status = aborted ? "stopped" : run.error ? "failed" : "completed";
    const idle = status === "completed" && child.options.persistent === true;
    let outcome = this.outcome(child, status, run.error ?? run.output, idle);
    child.state = idle ? "idle" : "closed";
    if (!idle) {
      try { await (child.closing ??= child.client.stop()); }
      catch (error) { outcome = { ...outcome, status: "failed", output: `Child shutdown failed: ${String(error)}` }; }
      finally { this.children.delete(child.id); }
    }
    run.resolve(outcome);
    if (run.notify && !this.closed) await this.deps.notify(outcome);
  }

  private async terminate(child: Child, status: "failed" | "stopped", output: string, notify: boolean): Promise<void> {
    if (child.state === "closed") { await (child.closing ??= child.client.stop()); return; }
    const wasIdle = child.state === "idle";
    child.state = "closed";
    clearTimeout(child.timer);
    const outcome = this.outcome(child, status, output, false);
    try { await (child.closing ??= child.client.stop()); }
    finally {
      this.children.delete(child.id);
      child.run.resolve(outcome);
      if (notify && (child.run.notify || wasIdle) && !this.closed) await this.deps.notify(outcome);
    }
  }

  private outcome(child: Child, status: Outcome["status"], output: string, idle: boolean): Outcome {
    return { agent_id: child.id, status, output, idle, session_path: child.options.sessionPath, provider: child.options.selection.provider, model: child.options.selection.modelId, thinking: child.thinking, ...(child.run.usage ? { usage: child.run.usage } : {}) };
  }

  private armTimeout(child: Child): void {
    clearTimeout(child.timer);
    if (child.options.timeoutMs !== undefined) child.timer = setTimeout(() => { void this.terminate(child, "stopped", "Task deadline exceeded", true).catch(() => {}); }, child.options.timeoutMs);
  }

  private taskPrompt(id: string, prompt: string): string {
    return `You are ${id}, a direct subagent. Work on the task below and return a concise final result to your parent. You cannot spawn agents. Use agent_send with to="@parent" to ask a question or send an intermediate update. Historical identities, tasks, tool handles, and one-off approvals in inherited context are not yours.\n\nTask:\n${prompt}`;
  }
}
