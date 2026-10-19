import { getMarkdownTheme, highlightCode, keyHint, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

function isResult(value: unknown): value is Record<string, unknown> & { agent_id: string; status: "completed" | "failed" | "stopped"; output: string } {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.agent_id === "string" && typeof result.output === "string"
    && (result.status === "completed" || result.status === "failed" || result.status === "stopped");
}

function jsonView(value: unknown): Text {
  return new Text(highlightCode(JSON.stringify(value, null, 2), "json").join("\n"), 0, 0);
}

/** Presentation only: keep the original content/details intact for model context and session replay. */
export const renderSubagentResult: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  let result: unknown = message.details;
  if (!isResult(result)) {
    const content = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    try { result = JSON.parse(content); } catch { return undefined; }
  }
  if (!isResult(result)) return undefined; // Let Pi render unknown/older message formats normally.

  const color = result.status === "completed" ? "success" : result.status === "failed" ? "error" : "warning";
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const model = typeof result.model === "string" ? ` · ${result.model}` : "";
  const idle = result.idle === true ? " · idle" : "";
  box.addChild(new Text(
    theme.style("[subagent]", { fg: "customMessageLabel", bold: true }) + " "
    + theme.fg(color, result.status) + " " + theme.fg("accent", result.agent_id)
    + theme.fg("dim", model + idle) + " · " + keyHint("app.tools.expand", expanded ? "answer" : "JSON"), 0, 0,
  ));
  box.addChild(new Spacer(1));

  if (expanded) {
    box.addChild(jsonView(result));
  } else {
    const output = result.output.trim();
    // JSON-only answers need formatting too; prose and fenced code use Pi's Markdown renderer.
    let json: unknown;
    try { json = JSON.parse(output); } catch { /* Not a JSON-only answer. */ }
    box.addChild(json !== null && typeof json === "object" ? jsonView(json)
      : new Markdown(output || "(no output)", 0, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("customMessageText", text),
      }));
    if (typeof result.full_output_path === "string") {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("warning", `Output truncated. Full output: ${result.full_output_path}`), 0, 0));
    }
  }
  return box;
};
