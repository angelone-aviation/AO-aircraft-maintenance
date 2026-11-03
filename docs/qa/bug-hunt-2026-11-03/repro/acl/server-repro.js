// Runs one convex-test file from ./server inside this checkout. The test
// asserts the correct behaviour, so a failing test means the bug reproduces.
// The file is copied into convex/ for the run and removed afterwards.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const [file, summary] = process.argv.slice(2);
const root = path.resolve(__dirname, "../../../../..");
const name = path.basename(file);
const target = path.join(root, "convex", name);
fs.copyFileSync(path.join(__dirname, "server", name), target);
let out = "";
try {
  const r = spawnSync("npx", ["vitest", "run", `convex/${name}`], {
    cwd: root,
    encoding: "utf8",
    timeout: 300000,
  });
  out = (r.stdout || "") + (r.stderr || "");
} finally {
  fs.rmSync(target, { force: true });
}
const error = out.match(/^(Error|AssertionError)[^\n]*/m)?.[0] ?? "";
if (/Tests\s+\d+ failed/.test(out)) {
  console.log(`REPRODUCED: ${summary} (${error})`);
  process.exit(1);
} else if (/Tests\s+\d+ passed/.test(out)) {
  console.log("NOT REPRODUCED");
  process.exit(0);
} else {
  console.log(out);
  process.exit(2);
}
