import { mkdir, writeFile } from "node:fs/promises";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Do not replay an assistant's unfinished tool batch (including sibling spawns). */
export function completedBranch(branch: readonly SessionEntry[]): SessionEntry[] {
  const completed = new Set(branch.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
  const boundary = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && !completed.has(block.id)));
  return structuredClone(boundary < 0 ? [...branch] : branch.slice(0, boundary));
}

/** A separate, private Pi session snapshot; never mutate or reopen the parent's file. */
export async function createChildSession(options: {
  cwd: string;
  dir: string;
  parentSession?: string;
  branch?: readonly SessionEntry[];
}): Promise<string> {
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const manager = SessionManager.create(options.cwd, options.dir, { parentSession: options.parentSession });
  const path = manager.getSessionFile();
  if (!path) throw new Error("Expected persistent child session");
  const entries = options.branch ? completedBranch(options.branch) : [];
  // The public JSONL format preserves compaction boundaries, context edits, and branch summaries.
  // Copying buildSessionContext().messages would flatten those and lose their semantics.
  await writeFile(path, [manager.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return path;
}
