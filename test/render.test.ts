import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomMessageComponent, highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentResult } from "../src/render.ts";

initTheme("dark", false);
type Message = ConstructorParameters<typeof CustomMessageComponent>[0];
const outcome = {
  agent_id: "agent-1234abcd", status: "completed", output: "## Findings\n\n**Fixed** the issue.\n\n```json\n{\"ok\":true}\n```",
  session_path: "/private/session.jsonl", provider: "test", model: "test-model", thinking: "low", idle: true,
};

function message(details: unknown = outcome): Message {
  return { role: "custom", customType: "subagent-result", content: JSON.stringify(details), details, display: true, timestamp: 1 };
}
function component(entry = message()) {
  return new CustomMessageComponent(entry, renderSubagentResult);
}
function plain(view: CustomMessageComponent, width = 120) {
  return view.render(width).map(stripTerminalSequences).join("\n");
}

test("result notifications show a status header and Markdown answer without raw metadata", () => {
  const text = plain(component());
  assert.match(text, /\[subagent\] completed agent-1234abcd/);
  assert.match(text, /test-model · idle/);
  assert.match(text, /Findings/);
  assert.match(text, /Fixed the issue/);
  assert.doesNotMatch(text, /\*\*|session_path|\/private\/session/);
  assert.match(text, /JSON/);
});

test("expansion shows the entire pretty-printed, highlighted payload and leaves it unchanged", () => {
  const details = Object.freeze({ ...outcome, extra: { preserved: true } });
  const entry = Object.freeze(message(details));
  const before = JSON.stringify(entry);
  const view = component(entry);
  view.setExpanded(true);
  const text = plain(view, 1000);
  const jsonStart = text.indexOf("{");
  assert.deepEqual(JSON.parse(text.slice(jsonStart)), details);
  assert.match(text, /\n +"agent_id": "agent-1234abcd",/);
  assert.ok(view.render(1000).join("\n").includes(highlightCode(JSON.stringify(details, null, 2), "json")[1]));
  assert.equal(JSON.stringify(entry), before);
  view.setExpanded(false);
  assert.doesNotMatch(plain(view), /session_path/);
});

test("JSON-only answers are formatted rather than displayed as a single dense line", () => {
  for (const output of ['{"ok":true,"items":[1,2]}', '[{"ok":true}]']) {
    const view = component(message({ ...outcome, output }));
    const text = plain(view);
    assert.match(text, /\n +"ok": true/);
    assert.doesNotMatch(text, /\\"ok\\"/);
  }
});

test("restored messages can render from string or text-block content without details", () => {
  for (const content of [JSON.stringify(outcome), [{ type: "text" as const, text: JSON.stringify(outcome) }]]) {
    const text = plain(component({ ...message(), details: undefined, content }));
    assert.match(text, /\[subagent\] completed/);
    assert.match(text, /Fixed the issue/);
  }
});

test("failed, stopped, empty and truncated answers remain visible", () => {
  for (const status of ["failed", "stopped"]) {
    assert.match(plain(component(message({ ...outcome, status, output: "A failure reason" }))), new RegExp(`\\[subagent\\] ${status}`));
    assert.match(plain(component(message({ ...outcome, status, output: "A failure reason" }))), /A failure reason/);
  }
  assert.match(plain(component(message({ ...outcome, output: "" }))), /\(no output\)/);
  const text = plain(component(message({ ...outcome, full_output_path: "/private/full-output.txt" })));
  assert.match(text, /Output truncated\. Full output: \/private\/full-output.txt/);
});

test("malformed and unrecognized messages fall back to Pi's default renderer", () => {
  for (const entry of [
    { ...message(), details: undefined, content: "not JSON" },
    message(null), message({ status: "completed", output: "missing agent id" }),
    message({ ...outcome, status: "unexpected" }), message({ ...outcome, output: null }),
  ]) {
    assert.match(plain(component(entry)), /\[subagent-result\]/);
  }
});

test("rendering respects narrow widths, Unicode, padding, resize and theme invalidation", () => {
  const view = component(message({ ...outcome, output: "**日本語** 👩‍⚕️\n\n```json\n{\"wide\":\"漢字👩‍⚕️\"}\n```" }));
  for (const expanded of [false, true]) {
    view.setExpanded(expanded);
    for (const width of [20, 40, 100]) {
      assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
    }
  }
  view.setExpanded(false);
  view.setOutputPad(3);
  assert.match(plain(view), /\n {3}\[subagent\]/);
  const dark = view.render(100).join("\n");
  try {
    initTheme("light", false);
    view.invalidate();
    const light = view.render(100).join("\n");
    assert.notEqual(light, dark);
    assert.equal(stripTerminalSequences(light), stripTerminalSequences(dark));
  } finally { initTheme("dark", false); }
});
