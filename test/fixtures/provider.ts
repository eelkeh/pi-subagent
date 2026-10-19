// Test-only deterministic provider. No network requests or production credentials.
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type TranscriptContext, type Model, type Api, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function textOf(message: any): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "test_confirm", label: "Test confirm", description: "Test-only approval request", parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => ({ content: [{ type: "text", text: JSON.stringify({ approved: await ctx.ui.confirm("Test approval", "Allow this test action?") }) }], details: undefined }) });
  pi.registerProvider("subagent-test", {
    api: "subagent-test-api", baseUrl: "https://invalid.test", apiKey: "test-only-key",
    models: ["parent", "cheap", "strong"].map((id) => ({ id, name: id, reasoning: id !== "cheap", input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048 })),
    streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        const messages = context.messages.filter((message) => message.role !== "system");
        const last = messages.at(-1);
        const text = last ? textOf(last) : "";
        const child = process.env.DELPHYR_PI_SUBAGENT_ID;
        const tool = (name: string, args: Record<string, any>) => { output.content = [{ type: "toolCall", id: `call-${Date.now()}`, name, arguments: args }]; output.stopReason = "toolUse"; };
        if (!child) {
          const match = /^(SPAWN|SEND|STOP):([\s\S]*)/.exec(text);
          if (match) tool({ SPAWN: "agent_spawn", SEND: "agent_send", STOP: "agent_stop" }[match[1]]!, JSON.parse(match[2]));
          else output.content = [{ type: "text", text: "ACK" }];
        } else if (last?.role === "toolResult") {
          output.content = [{ type: "text", text: textOf(last) || "CHILD_REPLIED" }];
        } else {
          const task = text.split("\nTask:\n").at(-1)!.replace(/^\[from @parent\] /, "");
          if (task === "HANG") {
            await new Promise<void>((resolve) => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
            output.stopReason = "aborted";
          } else if (task === "SEND_PARENT") {
            tool("agent_send", { to: "@parent", message: "child progress sentinel" });
          } else if (task === "ASK_APPROVAL") {
            tool("test_confirm", {});
          } else if (task === "FAIL") {
            output.stopReason = "error"; output.errorMessage = "deterministic provider failure";
          } else {
            output.content = [{ type: "text", text: JSON.stringify({ pid: process.pid, model: model.id, tools: getCurrentTools(context.messages).map((entry) => entry.name), hasSentinel: messages.some((message) => textOf(message).includes("CONTEXT_SENTINEL")), userMessages: messages.filter((message) => message.role === "user").length, task }) }];
          }
        }
        if (output.stopReason === "error" || output.stopReason === "aborted") stream.push({ type: "error", reason: output.stopReason, error: output });
        else stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
        stream.end();
      })().catch((error) => { output.stopReason = "error"; output.errorMessage = String(error); stream.push({ type: "error", reason: "error", error: output }); stream.end(); });
      return stream;
    },
  });
}
