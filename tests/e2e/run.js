// Runs every tests/e2e/*.test.js in its own process; fails if any fails.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n### ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit", timeout: 10 * 60 * 1000 });
  if (r.status !== 0) { failed++; console.error(`### ${f}: FAILED (exit ${r.status})`); }
}
console.log(`\n${files.length - failed}/${files.length} e2e files passed`);
process.exit(failed ? 1 : 0);
