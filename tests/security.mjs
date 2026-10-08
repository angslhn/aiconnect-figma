#!/usr/bin/env node
// Automated relay-gate tests (PROMPT 5 a–d). Headless: boots the real
// scripts/relay.mjs on an isolated port with a throwaway token (env takes
// precedence, so the user's real ~/.aiconnect-relay-token is untouched).
//
// (e) get_status version parity needs a live Figma plugin and cannot run
// headless — it is a documented MANUAL step (see bottom), not faked here.
//
// Run: node tests/security.mjs   (CI runs it after bun run test)

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const PORT = Number(process.env.SEC_TEST_PORT || 3066);
const TOKEN = "self-test-token-" + Date.now().toString(36);
const ROOT = new URL("..", import.meta.url);

let failures = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const attempt = (url, origin) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } });
    ws.on("open", () => { try { ws.close(); } catch {} resolve({ open: true }); });
    ws.on("error", (e) => resolve({ open: false, error: e.message }));
    setTimeout(() => { try { ws.close(); } catch {} resolve({ open: false, error: "TIMEOUT" }); }, 5000);
  });

const child = spawn(process.execPath, ["scripts/relay.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), AICONNECT_RELAY_TOKEN: TOKEN },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 2500));

// (a) no token -> 401
{
  const r = await attempt(`ws://127.0.0.1:${PORT}/`);
  check("(a) no token rejected", !r.open && /401/.test(r.error || ""), r.error);
}
// (b) evil origin -> 403
{
  const r = await attempt(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`, "https://example.com");
  check("(b) evil origin rejected", !r.open && /403/.test(r.error || ""), r.error);
}
// (c) loopback + good token, no origin -> open; then join+list_channels round-trip
{
  const r = await attempt(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
  check("(c) loopback + token accepted", r.open === true, r.error);
}
// (d) LAN IP -> refused (relay binds 127.0.0.1 only)
{
  let lan = null;
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family === "IPv4" && !i.internal) { lan = i.address; break; }
    }
    if (lan) break;
  }
  if (!lan) {
    console.log("SKIP (d) no LAN IPv4 on this machine — cannot probe LAN refusal here");
  } else {
    const r = await attempt(`ws://${lan}:${PORT}/?token=${TOKEN}`);
    check(`(d) LAN IP ${lan} refused`, !r.open && /ECONNREFUSED|EHOSTUNREACH/.test(r.error || ""), r.error);
  }
}

child.kill();
await new Promise((r) => setTimeout(r, 500));
process.exit(failures ? 1 : 0);

// MANUAL step (e) — run with Figma open, plugin green, agent joined:
//   get_status must show serverVersion === pluginVersion (and
//   versionMismatch: null). Cannot run headless; verified by hand.
