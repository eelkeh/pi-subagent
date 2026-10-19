import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildSession } from "./context.ts";
import { AgentManager, CHILD_ID_ENV, MESSAGE_KEY } from "./manager.ts";
import { DEFAULT_PROFILES, loadProfiles, selectProfile, THINKING, type Profiles } from "./profiles.ts";
import { presentOutcome } from "./results.ts";
import { renderSubagentResult } from "./render.ts";
import { forwardChildUi } from "./ui.ts";

const ThinkingSchema = Type.Union(THINKING.map((level) => Type.Literal(level)));
const SpawnSchema = Type.Object({
  prompt: Type.String({ minLength: 1, description: "Self-contained task, constraints, paths, and expected result." }),
  label: Type.String({ minLength: 1, description: "Short task label." }),
  task_type: Type.Optional(Type.String({ description: "Task profile: general, explore, implement, review, reason, or a configured custom profile." })),
  model: Type.Optional(Type.String({ description: "Override task profile with provider/modelId, an unambiguous exact model ID, or inherit." })),
  thinking: Type.Optional(ThinkingSchema),
  fork_context: Type.Optional(Type.Boolean({ description: "Copy the parent's completed active conversation branch. Default false; never copy abandoned branches or the unfinished spawning tool batch." })),
  persistent: Type.Optional(Type.Boolean({ description: "Keep child resident after completion for follow-up messages. Default false." })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and deliver a completion notification. Default false (wait for result). Background requires a long-lived parent." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist; agent_send is always included. Empty means communication only. Tool selection is not a sandbox." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Optional deadline per run, including persistent follow-ups." })),
}, { additionalProperties: false });
const SendSchema = Type.Object({ to: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const StopSchema = Type.Object({ agent_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

function result(value: unknown, isError = false) {
  const usage = value && typeof value === "object" && "usage" in value ? value.usage as Usage : undefined;
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value, ...(usage ? { usage } : {}), ...(isError ? { isError: true } : {}) };
}

/** Explicit file extensions loaded for this host should also load in children. Inline factories cannot cross processes. */
function extraExtensions(pi: ExtensionAPI, cwd: string): string[] {
  const paths = new Set([fileURLToPath(import.meta.url)]);
  for (let i = 0; i < process.argv.length; i++) {
    if (["-e", "--extension"].includes(process.argv[i]) && process.argv[i + 1]) {
      const path = process.argv[++i];
      paths.add(path.startsWith("builtin:") ? path : resolve(cwd, path));
    }
  }
  for (const tool of pi.getAllTools()) {
    const info = tool.sourceInfo;
    if (info.scope === "temporary" && isAbsolute(info.path)) paths.add(info.path);
  }
  return [...paths];
}

export default function subagent(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent-result", renderSubagentResult);
  const childId = process.env[CHILD_ID_ENV];
  let manager: AgentManager | undefined;
  let currentContext: ExtensionContext | undefined;

  const requireManager = (ctx: ExtensionContext) => {
    currentContext = ctx;
    return manager ??= new AgentManager({
      notify: async (outcome) => {
        const presented = await presentOutcome(outcome);
        pi.sendMessage({ customType: "subagent-result", content: JSON.stringify(presented), display: true, details: presented }, { deliverAs: "followUp", triggerTurn: true });
      },
      message: (id, text) => {
        pi.sendMessage({ customType: "subagent-message", content: JSON.stringify({ from: id, message: text }), display: true }, { deliverAs: "steer", triggerTurn: true });
      },
      ui: (id, event) => forwardChildUi(currentContext ?? ctx, id, event),
    });
  };

  pi.registerTool({
    name: "agent_send", label: "Agent send", parameters: SendSchema,
    description: childId ? "Send a progress update or question to @parent. No sibling routing or nested spawning. Delivery is best-effort, not an acknowledgement that the parent processed it." : "Send a message to a live direct child by agent_id. Steers running work or wakes a persistent idle child. @parent is unavailable in the root session.",
    execute: async (_id, args, _signal, _update, ctx) => {
      if (!args.message.trim()) throw new Error("Message must not be empty");
      if (childId) {
        if (args.to !== "@parent") throw new Error("Subagents can only address @parent; nesting is disabled");
        ctx.ui.setStatus(MESSAGE_KEY, args.message);
        return result({ to: "@parent", sent: true });
      }
      if (args.to === "@parent") throw new Error("Root session has no parent");
      return result(await requireManager(ctx).send(args.to, args.message));
    },
  });
  if (childId) return; // Child sessions never register agent_spawn or agent_stop.

  const registerSpawn = (profiles: Profiles) => pi.registerTool({
    name: "agent_spawn", label: "Agent spawn", parameters: SpawnSchema,
    description: "Delegate a bounded task to a separate Pi process. Choose task_type according to the work; its configured profile selects model and thinking. Explicit overrides win, otherwise unspecified settings inherit the parent. " + Object.entries(profiles).map(([name, profile]) => `${name}: ${profile.description} (model=${profile.model ?? "inherit"}, thinking=${profile.thinking ?? "inherit"})`).join("; "),
    promptSnippet: "Delegate independent tasks using task-appropriate model/thinking profiles",
    promptGuidelines: [
      "Choose a task_type matching the actual work; use configured profiles to balance quality, cost, and reasoning. Do not blindly inherit an expensive model for simple reconnaissance.",
      "Subagents start with no conversation history unless fork_context=true. Give self-contained instructions, constraints, and paths.",
      "Keep working on non-overlapping tasks while background agents run; completion arrives automatically, never poll.",
      "Use persistent=true when follow-ups need the same child context. agent_send only addresses live direct children; nested spawning is disabled.",
      "Children share your filesystem, not separate Git worktrees. Use disjoint write scopes and review their changes.",
    ],
    execute: async (_id, args, signal, _update, ctx) => {
      if (!ctx.model) throw new Error("No parent model selected");
      if (!args.prompt.trim() || !args.label.trim()) throw new Error("Task and label must not be empty");
      const availableProfiles = await loadProfiles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
      const selection = selectProfile(availableProfiles, args, { provider: ctx.model.provider, id: ctx.model.id, thinking: pi.getThinkingLevel() }, ctx.modelRegistry.getAvailable());
      const path = await createChildSession({ cwd: ctx.cwd, dir: join(getAgentDir(), "subagent-sessions"), parentSession: ctx.sessionManager.getSessionFile(), branch: args.fork_context ? ctx.sessionManager.getBranch() : undefined });
      const outcome = await requireManager(ctx).spawn({ prompt: args.prompt, label: args.label, cwd: ctx.cwd, sessionPath: path, selection, extensionPaths: extraExtensions(pi, ctx.cwd), tools: args.tools, trusted: ctx.isProjectTrusted(), persistent: args.persistent, background: args.run_in_background, timeoutMs: args.timeoutMs }, signal);
      const presented = "output" in outcome ? await presentOutcome(outcome) : outcome;
      return result(presented, outcome.status === "failed" || outcome.status === "stopped");
    },
  });
  registerSpawn(DEFAULT_PROFILES);
  pi.registerTool({
    name: "agent_stop", label: "Agent stop", parameters: StopSchema,
    description: "Shut down a live direct child, running or persistent-idle. Does not send a completion notification. Its persisted transcript remains available.",
    execute: async (_id, args, _signal, _update, ctx) => { await requireManager(ctx).stop(args.agent_id); return result({ agent_id: args.agent_id, status: "stopped" }); },
  });
  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    registerSpawn(await loadProfiles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted()));
  });
  pi.on("before_agent_start", (_event, ctx) => { currentContext = ctx; });
  pi.on("session_shutdown", async () => { await manager?.shutdown(); manager = undefined; currentContext = undefined; });
}
