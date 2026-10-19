import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

export type RecordMessage = Record<string, any>;
export interface Transport {
  request(command: RecordMessage): Promise<any>;
  write(message: RecordMessage): void;
  stop(): Promise<void>;
}
export interface RpcOptions {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onEvent(event: RecordMessage): void;
  onExit(error: Error): void;
  command?: string;
  prefix?: string[];
  requestTimeoutMs?: number;
  stopGraceMs?: number;
}

/** Strict LF JSONL transport. Dialogs stay visible to the parent, unlike RpcClient.onEvent(). */
export class RpcProcess implements Transport {
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderr = "";
  private exited = false;
  private stopping = false;
  private stopped?: Promise<void>;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private readonly options: RpcOptions;

  constructor(options: RpcOptions) {
    this.options = options;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    this.process = spawn(options.command ?? process.execPath, [...(options.prefix ?? [cli, "--mode", "rpc"]), ...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.read(chunk));
    this.process.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65536); });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.process.on("close", (code, signal) => {
      this.exited = true;
      const error = new Error(`Child Pi exited (${signal ?? code}). ${this.stderr}`);
      this.fail(error);
      this.resolveExit();
      if (!this.stopping) options.onExit(error);
    });
  }

  request(command: RecordMessage): Promise<any> {
    if (this.stopping || this.exited) return Promise.reject(new Error("Child Pi is closed"));
    const id = `request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Child Pi timed out accepting '${command.type}'`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...command, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  write(message: RecordMessage): void {
    if (this.exited || this.process.stdin.destroyed || this.process.stdin.writableEnded) throw new Error("Child Pi input is closed");
    // Node's writable queue preserves order and backpressure; no synchronous pipe writes.
    this.process.stdin.write(JSON.stringify(message) + "\n", (error) => { if (error) this.fail(error); });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (line.length > 16 * 1024 * 1024) { this.protocolError(); return; }
      let message: RecordMessage;
      try { message = JSON.parse(line); }
      catch { this.protocolError(); return; }
      if (!message || typeof message !== "object" || typeof message.type !== "string") { this.protocolError(); return; }
      if (message.type === "response") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.success) waiter.resolve(message.data);
        else waiter.reject(new Error(message.error ?? `Child command '${message.command}' failed`));
      } else {
        this.options.onEvent(message);
      }
    }
    if (this.buffer.length > 16 * 1024 * 1024) this.protocolError();
  }

  private protocolError(): void {
    const error = new Error("Invalid or oversized child Pi JSONL record");
    this.buffer = "";
    this.fail(error);
    this.options.onExit(error);
    void this.stop();
  }

  private fail(error: Error): void {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }

  stop(): Promise<void> {
    return this.stopped ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    this.fail(new Error("Child Pi stopped"));
    if (this.exited) return;
    this.process.stdin.end();
    if (await this.waitExit(this.options.stopGraceMs ?? 2_000)) return;
    this.signal("SIGTERM");
    if (await this.waitExit(500)) return;
    this.signal("SIGKILL");
    if (!(await this.waitExit(1_000))) throw new Error("Child Pi did not exit after SIGKILL");
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.process.pid;
    if (!pid) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.process.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([this.exitPromise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
}
