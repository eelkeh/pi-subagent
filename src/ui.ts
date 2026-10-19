import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RecordMessage } from "./rpc.ts";

/** Never auto-approve child dialogs. Headless hosts cancel them (fail closed). */
export async function forwardChildUi(ctx: Pick<ExtensionContext, "hasUI" | "ui">, id: string, event: RecordMessage): Promise<RecordMessage | undefined> {
  const dialog = ["confirm", "select", "input", "editor"].includes(event.method);
  if (!ctx.hasUI) return dialog ? { cancelled: true } : undefined;
  const title = `[${id}] ${event.title ?? "Subagent"}`;
  const options = typeof event.timeout === "number" ? { timeout: event.timeout } : undefined;
  switch (event.method) {
    case "confirm": return { confirmed: await ctx.ui.confirm(title, String(event.message ?? ""), options) };
    case "select": {
      const value = await ctx.ui.select(title, event.options ?? [], options);
      return value === undefined ? { cancelled: true } : { value };
    }
    case "input": {
      const value = await ctx.ui.input(title, event.placeholder, options);
      return value === undefined ? { cancelled: true } : { value };
    }
    case "editor": {
      const value = await ctx.ui.editor(title, event.prefill);
      return value === undefined ? { cancelled: true } : { value };
    }
    case "notify": ctx.ui.notify(`[${id}] ${event.message}`, event.notifyType); return undefined;
    // Child title/editor/widget/status changes must not overwrite the parent UI.
    default: return undefined;
  }
}
