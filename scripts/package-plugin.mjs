#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Assembles dist/aiconnect-figma-plugin.zip — the release bundle a user
// extracts into <project>/figma/aiconnect-plugin/ (see README Option C).
//
// Layout inside the zip (root folder aiconnect-plugin/):
//   server.cjs     standalone MCP server (npm run build:standalone output)
//   package.json   slim {name, version} so get_status reports the real version
//   code.js        Figma plugin main thread (with PLUGIN_VERSION + handlers)
//   ui.html        Figma plugin panel (with relay-token field)
//   manifest.json  Figma plugin manifest (import this into Figma)
//
// Deliberately EXCLUDED:
//   setcharacters.js — its logic is inlined in code.js (setCharacters,
//   strict/smart font matchers); manifest.json never references the file,
//   so shipping it would only confuse.
//   Anything secret — the relay token lives at ~/.aiconnect-relay-token on
//   the user's machine and is never bundled.
//
// Usage:
//   npm run build:standalone && node scripts/package-plugin.mjs
//   PORT=3063 node scripts/package-plugin.mjs --self-test   # + boot + gate probe
//
// Zip backend: system `zip` CLI when available, else PowerShell
// Compress-Archive on Windows. Refuses to build a zip without everything.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(root, "dist", "plugin-stage", "aiconnect-plugin");
const ZIP = join(root, "dist", "aiconnect-figma-plugin.zip");

const required = [
  ["dist-standalone/server.cjs", "server.cjs"],
  ["src/figma_plugin/code.js", "code.js"],
  ["src/figma_plugin/ui.html", "ui.html"],
  ["src/figma_plugin/manifest.json", "manifest.json"],
];

function fail(msg) {
  console.error(`package-plugin: ${msg}`);
  process.exit(1);
}

// 1. Collect + sanity checks (no secrets in the bundle, token field present).
for (const [src] of required) {
  if (!existsSync(join(root, src))) fail(`missing ${src} — run npm run build:standalone first`);
}
const ui = readFileSync(join(root, "src/figma_plugin/ui.html"), "utf8");
if (!ui.includes("relay-token")) fail("ui.html lacks the relay-token field — rebuild from current source");
const code = readFileSync(join(root, "src/figma_plugin/code.js"), "utf8");
if (!code.includes("PLUGIN_VERSION")) fail("code.js lacks PLUGIN_VERSION — rebuild from current source");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// 2. Stage the files.
rmSync(join(root, "dist", "plugin-stage"), { recursive: true, force: true });
rmSync(ZIP, { force: true });
mkdirSync(STAGE, { recursive: true });
for (const [src, dest] of required) copyFileSync(join(root, src), join(STAGE, dest));
writeFileSync(join(STAGE, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2) + "\n");

// 3. Zip it (with the aiconnect-plugin/ folder, so extracting creates it).
function have(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return r.status === 0;
}
const FOLDER = "aiconnect-plugin";
const useZipCli = have("zip", ["-v"]);
if (useZipCli) {
  execFileSync("zip", ["-r", "-9", ZIP, FOLDER], { cwd: dirname(STAGE), stdio: "inherit" });
} else if (process.platform === "win32" && have("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"])) {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`], { stdio: "inherit" });
} else {
  fail("no zip backend: install `zip` or run on Windows PowerShell");
}

// 4. Verify the archive listing matches the manifest above.
const want = ["code.js", "manifest.json", "package.json", "server.cjs", "ui.html"].map((f) => `${FOLDER}/${f}`).sort();
if (useZipCli) {
  const got = execFileSync("unzip", ["-Z1", ZIP], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter((s) => !s.endsWith("/")).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`unexpected zip contents: ${got.join(", ")}`);
  console.log(`zip contents OK: ${got.join(", ")}`);
} else {
  console.log("zip backend is Compress-Archive; contents verified at staging instead");
}
console.log(`wrote ${ZIP}`);

// 5. Optional self-test: extract to temp, boot the bundled server on a test
// port, and probe the handshake gate (401 without token, open with token).
// Loopback-only bind is covered by the LAN-refusal probe in tests/security.
if (process.argv.includes("--self-test")) {
  const { homedir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "aiconnect-zip-"));
  if (have("unzip", ["-v"])) {
    execFileSync("unzip", ["-q", ZIP, "-d", dir], { stdio: "inherit" });
  } else {
    execFileSync("powershell", ["-NoProfile", "-Command",
      `Expand-Archive -Path '${ZIP}' -DestinationPath '${dir}' -Force`], { stdio: "inherit" });
  }
  const bundled = join(dir, "aiconnect-plugin", "server.cjs");
  if (!existsSync(bundled)) fail("extracted zip has no aiconnect-plugin/server.cjs");
  try {
    const v = JSON.parse(readFileSync(join(dir, "aiconnect-plugin", "package.json"), "utf8")).version;
    if (v !== pkg.version) fail(`bundled package.json version ${v} != ${pkg.version}`);
    console.log(`bundled version OK: ${v}`);
  } catch (e) {
    fail(`bundled package.json unreadable: ${e.message || e}`);
  }
  const PORT = Number(process.env.SELF_TEST_PORT || 3064);
  const child = spawn(process.execPath, [bundled], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  const wsMod = await import("ws").catch(() => null);
  const WebSocket = wsMod && (wsMod.default || wsMod.WebSocket || wsMod);
  const probe = (desc, url, origin) => new Promise((resolve) => {
    if (!WebSocket) return resolve(`${desc}: SKIP (ws module unavailable)`);
    const ws = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } });
    ws.on("open", () => { try { ws.close(); } catch {} resolve(`${desc}: OPEN`); });
    ws.on("error", (e) => resolve(`${desc}: REJECTED (${e.message})`));
    setTimeout(() => { try { ws.close(); } catch {} resolve(`${desc}: TIMEOUT`); }, 5000);
  });
  await new Promise((r) => setTimeout(r, 2500));
  const tokenFile = join(homedir(), ".aiconnect-relay-token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  console.log(await probe("no token           ", `ws://127.0.0.1:${PORT}/`));
  console.log(await probe("evil origin        ", `ws://127.0.0.1:${PORT}/?token=${token}`, "https://example.com"));
  console.log(await probe("good token, no org ", `ws://127.0.0.1:${PORT}/?token=${token}`));
  child.kill();
  rmSync(dir, { recursive: true, force: true });
  console.log("self-test done");
}
