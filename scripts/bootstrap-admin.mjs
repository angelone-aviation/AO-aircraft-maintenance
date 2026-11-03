import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question("Administrator email: ")).trim();
const name = (await rl.question("Administrator name: ")).trim();
rl.close();
if (!process.stdin.isTTY)
  throw new Error("Run this setup in an interactive terminal.");
process.stdout.write("Password (12–128 characters, hidden): ");
const password = await new Promise((resolve) => {
  let secret = "";
  process.stdin.setRawMode(true);
  process.stdin.resume();
  function read(buffer) {
    for (const c of buffer.toString()) {
      if (c === "\u0003") {
        process.stdin.setRawMode(false);
        process.exit(130);
      }
      if (c === "\r" || c === "\n") {
        process.stdin.off("data", read);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(secret);
        return;
      }
      if (c === "\u007f") {
        secret = secret.slice(0, -1);
      } else if (c >= " ") secret += c;
    }
  }
  process.stdin.on("data", read);
});
// Pass the password over stdin into a temporary deployment env var so it never
// appears in process arguments, then always remove it.
const convex = (args, input) =>
  spawnSync("npx", ["convex", ...args], { input, encoding: "utf8" });
const set = convex(["env", "set", "BOOTSTRAP_ADMIN_PASSWORD"], password);
if (set.status !== 0) {
  process.stderr.write(set.stderr || "Administrator setup failed.\n");
  process.exit(1);
}
let result;
try {
  result = convex(["run", "admin:bootstrap", JSON.stringify({ email, name })]);
} finally {
  const removed = convex(["env", "remove", "BOOTSTRAP_ADMIN_PASSWORD"]);
  if (removed.status !== 0)
    process.stderr.write(
      "Remove BOOTSTRAP_ADMIN_PASSWORD manually: npx convex env remove BOOTSTRAP_ADMIN_PASSWORD\n",
    );
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || "Administrator setup failed.\n");
  process.exit(1);
}
console.log("Administrator created. You can now sign in.");
