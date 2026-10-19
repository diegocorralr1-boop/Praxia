// Sanity checks for the static pages: every local script/stylesheet they reference exists,
// no inline <script> (the CSP forbids it), no inline event handlers, pinned CDN scripts carry SRI.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html"));
let problems = 0;
const bad = (page, msg) => {
  problems++;
  console.error(`${page}: ${msg}`);
};
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  if (/<script>|<script\s+type="module">/.test(html)) bad(page, "inline <script> block (CSP forbids inline scripts)");
  const handlers = html.match(/\son[a-z]+="/g);
  if (handlers) bad(page, `inline event handler(s): ${[...new Set(handlers)].join(" ")}`);
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)) {
    const src = m[1];
    if (/^https?:/.test(src)) {
      if (!/integrity="sha(256|384|512)-/.test(m[0])) bad(page, `CDN script without integrity attribute: ${src}`);
      if (!/@\d+\.\d+\.\d+\//.test(src)) bad(page, `CDN script not pinned to an exact version: ${src}`);
    } else if (!fs.existsSync(path.join(root, src))) bad(page, `missing script file: ${src}`);
  }
  for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1]) && !fs.existsSync(path.join(root, m[1]))) bad(page, `missing stylesheet: ${m[1]}`);
  }
}
// Every element id the app script asks for statically must exist in index.html (ids inside template
// strings are created at runtime and can't be checked here, so only ids used before any innerHTML).
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const staticIds = [...app.matchAll(/^\$\("#([a-z0-9-]+)"\)/gm)].map((m) => m[1]);
for (const id of new Set(staticIds)) if (!index.includes(`id="${id}"`)) bad("app.js", `references #${id}, not found in index.html`);
if (problems) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
console.log(`check-html: ${pages.length} pages OK`);
