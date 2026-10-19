import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { RpcProcess } from "../src/rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url));
function child(extra: Partial<ConstructorParameters<typeof RpcProcess>[0]> = {}) {
  return new RpcProcess({ cwd: process.cwd(), command: process.execPath, prefix: [fixture], args: [], onEvent: () => {}, onExit: () => {}, ...extra });
}

test("RPC correlates concurrent out-of-order replies and preserves Unicode line separators", async (t) => {
  const rpc = child(); t.after(() => rpc.stop());
  const text = "emoji 😀 and separator \u2028 stays inside JSON";
  const [slow, fast] = await Promise.all([rpc.request({ type: "echo", text, delay: 20 }), rpc.request({ type: "echo", text: "fast" })]);
  assert.equal(slow.echo, text); assert.equal(fast.echo, "fast");
  await assert.rejects(rpc.request({ type: "error" }), /rejected/);
});

test("RPC request deadline, malformed output, and unexpected exit reject instead of hanging", async (t) => {
  const timeout = child({ requestTimeoutMs: 100 }); t.after(() => timeout.stop());
  await assert.rejects(timeout.request({ type: "ignore" }), /timed out/);
  const malformed = child(); t.after(() => malformed.stop());
  await assert.rejects(malformed.request({ type: "invalid" }), /Invalid/);
  const exit = child(); t.after(() => exit.stop());
  await assert.rejects(exit.request({ type: "exit" }), /exited/);
  await assert.rejects(exit.request({ type: "echo" }), /closed/);
});

test("RPC shutdown is idempotent and terminates an uncooperative process group", { skip: process.platform === "win32" }, async () => {
  const rpc = child({ env: { TEST_IGNORE_EOF: "1" }, stopGraceMs: 20 });
  const { pid } = await rpc.request({ type: "grandchild" });
  await Promise.all([rpc.stop(), rpc.stop()]);
  assert.throws(() => process.kill(rpc.process.pid!, 0), /ESRCH/);
  // A killed orphan can briefly remain a zombie until PID 1 reaps it; it is not running.
  try { const state = await readFile(`/proc/${pid}/stat`, "utf8"); assert.match(state, /\) Z /); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
});
