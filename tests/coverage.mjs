#!/usr/bin/env bun
/**
 * Connection-free wiring test: every command the MCP server sends to Figma must
 * have a matching `case` handler in the plugin, and the plugin's handlers should
 * be reachable. Catches drift between server.ts and the plugin code.js without
 * needing Figma open. Run: bun tests/coverage.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = readFileSync(join(root, "src/aiconnect_mcp/server.ts"), "utf8");
const plugin = readFileSync(join(root, "src/figma_plugin/code.js"), "utf8");

// Commands the MCP server forwards to Figma.
const sent = new Set();
for (const m of server.matchAll(/sendCommandToFigma\(\s*["'`]([a-z_]+)["'`]/g)) sent.add(m[1]);

// Command cases the plugin handles (inside handleCommand's switch).
const handled = new Set();
for (const m of plugin.matchAll(/case\s+["'`]([a-z_]+)["'`]\s*:/g)) handled.add(m[1]);

// "join" is handled by the relay/UI, not handleCommand — exclude from the check.
const ignore = new Set(["join"]);

const missing = [...sent].filter((c) => !handled.has(c) && !ignore.has(c)).sort();
const orphanHandlers = [...handled].filter((c) => !sent.has(c)).sort();

console.log(`MCP commands sent:   ${[...sent].length}`);
console.log(`Plugin case handlers: ${[...handled].length}`);

// Our custom additions must be present on both sides.
const custom = ["set_image_fill", "set_font_name", "insert_child", "set_effect", "set_gradient_fill", "create_ellipse", "create_svg", "batch_ops",
  "get_status", "get_console_logs", "get_page_snapshot", "get_variables", "create_variable_collection", "create_variable", "set_variable_value", "bind_variable", "get_css"];
const customOk = custom.every((c) => sent.has(c) && handled.has(c));
console.log(`Custom commands wired (tool + handler): ${customOk ? "yes ✓" : "NO ✗"}`);
for (const c of custom) {
  if (!(sent.has(c) && handled.has(c))) console.log(`  ✗ ${c}: tool=${sent.has(c)} handler=${handled.has(c)}`);
}

if (orphanHandlers.length) console.log(`Handlers with no MCP tool (ok if internal): ${orphanHandlers.join(", ")}`);

if (missing.length) {
  console.log(`\n✗ MCP commands with NO plugin handler: ${missing.join(", ")}`);
  process.exit(1);
}
if (!customOk) {
  console.log(`\n✗ One or more custom commands are not wired on both sides.`);
  process.exit(1);
}
console.log(`\nALL WIRED ✅  (every MCP command has a plugin handler; custom commands present)`);

// ---- Docs-vs-code sync (PROMPT 3): README counts, plugin version, command list.
let failed = false;
const fail = (msg) => { console.log(`✗ ${msg}`); failed = true; };

// 1. Every "**N tools**" claim in README must equal the real server.tool count.
const toolCount = (server.match(/server\.tool\(/g) || []).length;
const readme = readFileSync(join(root, "README.md"), "utf8");
const claimed = [...readme.matchAll(/\*\*(\d+) tools\*\*/g)].map((m) => Number(m[1]));
console.log(`server.tool count: ${toolCount}; README claims: ${[...new Set(claimed)].join(", ") || "(none)"}`);
if (!claimed.length) fail("README contains no '**N tools**' claim to check");
for (const n of new Set(claimed)) {
  if (n !== toolCount) fail(`README claims ${n} tools but code has ${toolCount}`);
}

// 2. PLUGIN_VERSION in code.js must match package.json.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pv = plugin.match(/const PLUGIN_VERSION\s*=\s*["'`]([^"'`]+)["'`]/);
console.log(`package.json: ${pkg.version}; PLUGIN_VERSION: ${pv ? pv[1] : "(missing)"}`);
if (!pv) fail("PLUGIN_VERSION constant missing in code.js");
else if (pv[1] !== pkg.version) fail(`PLUGIN_VERSION ${pv[1]} != package.json ${pkg.version}`);

// 3. PLUGIN_COMMANDS must equal the handleCommand case labels (minus
// non-command cases: ui-level "notify", gradient directions, commented code).
const arrSrc = plugin.match(/const PLUGIN_COMMANDS\s*=\s*\[(.*?)\]/s);
const listed = new Set(arrSrc ? [...arrSrc[1].matchAll(/["'`]([a-z_]+)["'`]/g)].map((m) => m[1]) : []);
const nonCommands = new Set(["notify", "horizontal", "diagonal", "vertical", "get_team_components"]);
const expected = new Set([...handled].filter((c) => !nonCommands.has(c)));
const extra = [...listed].filter((c) => !expected.has(c)).sort();
const unlisted = [...expected].filter((c) => !listed.has(c)).sort();
console.log(`PLUGIN_COMMANDS: ${listed.size}; handleCommand cases: ${expected.size}`);
if (extra.length) fail(`PLUGIN_COMMANDS has extras not in handleCommand: ${extra.join(", ")}`);
if (unlisted.length) fail(`handleCommand cases missing from PLUGIN_COMMANDS: ${unlisted.join(", ")}`);

if (failed) {
  console.log(`\nDOCS OUT OF SYNC ✗ (fix README counts / PLUGIN_VERSION / PLUGIN_COMMANDS)`);
  process.exit(1);
}
console.log(`DOCS IN SYNC ✅  (README counts, versions, and command list match code)`);
process.exit(0);
