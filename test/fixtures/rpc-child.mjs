import { spawn } from "node:child_process";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "exit") process.exit(7);
    else if (command.type === "invalid") process.stdout.write("not JSON\n");
    else if (command.type === "ignore") continue;
    else if (command.type === "error") process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: false, error: "rejected" }) + "\n");
    else if (command.type === "grandchild") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { pid: child.pid } }) + "\n");
    } else {
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { echo: command.text } }) + "\n"), command.delay ?? 0);
    }
  }
});
if (process.env.TEST_IGNORE_EOF) setInterval(() => {}, 1000);
else process.stdin.on("end", () => process.exit(0));
