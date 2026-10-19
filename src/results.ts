import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { Outcome } from "./manager.ts";

export async function presentOutcome(outcome: Outcome): Promise<Outcome & { full_output_path?: string }> {
  const preview = truncateTail(outcome.output);
  if (!preview.truncated) return outcome;
  const path = `${outcome.session_path}.${randomUUID()}.output.txt`;
  await writeFile(path, outcome.output, { flag: "wx", mode: 0o600 });
  return { ...outcome, output: preview.content, full_output_path: path };
}
