import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];
export interface Profile {
  description: string;
  model?: string;
  thinking?: Thinking | "inherit";
}
export type Profiles = Record<string, Profile>;
export const DEFAULT_PROFILES: Profiles = {
  general: { description: "General delegation; inherit model and thinking." },
  explore: { description: "Bounded searches and codebase reconnaissance.", thinking: "low" },
  implement: { description: "Concrete code changes and tests.", thinking: "medium" },
  review: { description: "Correctness, security, and regression review.", thinking: "high" },
  reason: { description: "Difficult debugging, architecture, or synthesis.", thinking: "high" },
};

export function parseProfiles(input: unknown): Record<string, Partial<Profile>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("subagents.json must be an object");
  const top = input as Record<string, unknown>;
  if (Object.keys(top).some((key) => key !== "profiles")) throw new Error("Only 'profiles' is supported in subagents.json");
  if (!top.profiles || typeof top.profiles !== "object" || Array.isArray(top.profiles)) throw new Error("profiles must be an object");
  const result: Record<string, Partial<Profile>> = Object.create(null);
  for (const [name, value] of Object.entries(top.profiles)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`Invalid task profile: ${name}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid profile: ${name}`);
    const profile = value as Record<string, unknown>;
    if (Object.keys(profile).some((key) => !["model", "thinking", "description"].includes(key))) throw new Error(`Unknown setting in profile: ${name}`);
    for (const key of ["model", "description"]) {
      if (profile[key] !== undefined && (typeof profile[key] !== "string" || !(profile[key] as string).trim())) throw new Error(`Invalid ${key} in profile: ${name}`);
    }
    if (profile.thinking !== undefined && profile.thinking !== "inherit" && !THINKING.includes(profile.thinking as Thinking)) throw new Error(`Invalid thinking in profile: ${name}`);
    result[name] = { ...profile } as Partial<Profile>;
  }
  return result;
}

export async function loadProfiles(agentDir: string, cwd: string, trusted: boolean): Promise<Profiles> {
  const profiles = structuredClone(DEFAULT_PROFILES);
  const paths = [join(agentDir, "subagents.json"), ...(trusted ? [join(cwd, ".pi", "subagents.json")] : [])];
  for (const path of paths) {
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const parsed = parseProfiles(JSON.parse(text));
    for (const [name, profile] of Object.entries(parsed)) {
      const merged = { ...profiles[name], ...profile };
      profiles[name] = { ...merged, description: merged.description ?? name };
    }
  }
  return profiles;
}

export interface Selection { provider: string; modelId: string; thinking: Thinking; strictThinking: boolean }
export function selectProfile(
  profiles: Profiles,
  args: { task_type?: string; model?: string; thinking?: Thinking },
  parent: { provider: string; id: string; thinking: Thinking },
  models: readonly { provider: string; id: string }[],
): Selection {
  const name = args.task_type ?? "general";
  if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown task_type '${name}'. Available: ${Object.keys(profiles).join(", ")}`);
  const profile = profiles[name];
  const requested = args.model ?? profile.model ?? "inherit";
  const matches = requested === "inherit" ? [parent] : models.filter((model) => `${model.provider}/${model.id}` === requested || model.id === requested);
  if (matches.length !== 1) throw new Error(`Model '${requested}' is ${matches.length ? "ambiguous; use provider/modelId" : "not available"}`);
  const model = matches[0];
  const desired = args.thinking ?? profile.thinking ?? "inherit";
  return { provider: model.provider, modelId: model.id, thinking: desired === "inherit" ? parent.thinking : desired, strictThinking: args.thinking !== undefined };
}

export function supportedThinking(requested: Thinking, available: readonly Thinking[], strict: boolean): Thinking {
  if (available.includes(requested)) return requested;
  if (strict) throw new Error(`Thinking '${requested}' is unsupported; available: ${available.join(", ")}`);
  const below = available.filter((level) => THINKING.indexOf(level) <= THINKING.indexOf(requested));
  const selected = below.at(-1) ?? available[0];
  if (!selected) throw new Error("Child returned no supported thinking levels");
  return selected;
}
