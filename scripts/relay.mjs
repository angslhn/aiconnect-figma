#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Prakhar Gupta.
//
// Node-runnable WebSocket relay for AIConnect for Figma.
//
// This is a dependency-light, Bun-free port of src/socket.ts so the whole
// stack can run with plain `node` / `npx` (no Bun required). It brokers
// channel-scoped messages between the MCP server and the Figma plugin on
// ws://localhost:3055. Behaviour matches src/socket.ts byte-for-byte on the
// wire (join / message / progress_update / broadcast envelopes).
//
// Usage (the MCP server hosts the relay itself; you only need this to run it
// standalone, e.g. to share one relay across several agents):
//   npx -y aiconnect-figma-mcp relay            # default port 3055
//   PORT=4000 npx -y aiconnect-figma-mcp relay  # custom port
//   node scripts/relay.mjs                      # from a clone
//
// Security: binds 127.0.0.1 by default (AICONNECT_RELAY_HOST to override),
// rejects non-null web Origins, and requires ?token= matching
// AICONNECT_RELAY_TOKEN or the auto-created ~/.aiconnect-relay-token file.

import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || process.env.AICONNECT_RELAY_PORT || 3055);
// Loopback only by default; override with AICONNECT_RELAY_HOST at your own risk.
const HOST = process.env.AICONNECT_RELAY_HOST || "127.0.0.1";

// Shared relay token (main auth layer — a sandboxed web iframe also sends
// Origin "null", so Origin checks alone can't identify the plugin).
// Precedence: AICONNECT_RELAY_TOKEN env, else a stable per-user file,
// auto-created once (mode 600). Same file the MCP server uses.
const TOKEN_FILE = join(homedir(), ".aiconnect-relay-token");
function getToken() {
  const fromEnv = (process.env.AICONNECT_RELAY_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch { /* first run */ }
  const fresh = randomBytes(32).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, fresh + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`Could not persist relay token to ${TOKEN_FILE}:`, err.message || err);
  }
  return fresh;
}
const TOKEN = getToken();

// Store clients by channel.
const channels = new Map();
// Most recently joined channel — lets the MCP server auto-discover the plugin.
let lastJoinedChannel = null;

const wss = new WebSocketServer({
  port: PORT,
  host: HOST,
  // Handshake gate; wire message format is untouched.
  verifyClient: (info, done) => {
    const origin = String((info.req && info.req.headers && info.req.headers.origin) || "");
    if (origin && origin !== "null") {
      done(false, 403, "Forbidden origin");
      return;
    }
    let token = "";
    try {
      token = new URL(info.req.url || "/", "ws://relay").searchParams.get("token") || "";
    } catch { /* reject below */ }
    if (!token || token !== TOKEN) {
      done(false, 401, "Unauthorized relay token");
      return;
    }
    done(true);
  },
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("listening", () => {
  console.log(`AIConnect relay running on ws://${HOST}:${PORT} (loopback only unless AICONNECT_RELAY_HOST is set)`);
  console.log(`Relay token stored at ${TOKEN_FILE} — paste it into the Figma plugin's "Relay token" field once.`);
  console.log("Leave this running. Next: run the AIConnect plugin in Figma and copy the channel id.");
});

wss.on("connection", (ws) => {
  console.log("New client connected");

  // Welcome message (matches src/socket.ts).
  send(ws, { type: "system", message: "Please join a channel to start chatting" });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      console.error("Error handling message:", err);
      return;
    }

    const type = data.type;

    if (type === "list_channels") {
      const active = [...channels.entries()].filter(([, s]) => s.size > 0).map(([name]) => name);
      send(ws, { type: "channels", channels: active, lastJoined: lastJoinedChannel });
      return;
    }

    if (type === "join") {
      const channelName = data.channel;
      if (!channelName || typeof channelName !== "string") {
        send(ws, { type: "error", message: "Channel name is required" });
        return;
      }
      if (!channels.has(channelName)) channels.set(channelName, new Set());
      const channelClients = channels.get(channelName);
      channelClients.add(ws);
      lastJoinedChannel = channelName;
      console.log(`✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

      send(ws, { type: "system", message: `Joined channel: ${channelName}`, channel: channelName });
      send(ws, {
        type: "system",
        message: { id: data.id, result: "Connected to channel: " + channelName },
        channel: channelName,
      });

      for (const client of channelClients) {
        if (client !== ws) {
          send(client, { type: "system", message: "A new user has joined the channel", channel: channelName });
        }
      }
      return;
    }

    if (type === "message") {
      const channelName = data.channel;
      if (!channelName || typeof channelName !== "string") {
        send(ws, { type: "error", message: "Channel name is required" });
        return;
      }
      const channelClients = channels.get(channelName);
      if (!channelClients || !channelClients.has(ws)) {
        send(ws, { type: "error", message: "You must join the channel first" });
        return;
      }
      let broadcastCount = 0;
      for (const client of channelClients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          broadcastCount++;
          send(client, { type: "broadcast", message: data.message, sender: "peer", channel: channelName });
        }
      }
      if (broadcastCount === 0) {
        console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
      }
      return;
    }

    if (type === "progress_update") {
      const channelName = data.channel;
      if (!channelName) return;
      const channelClients = channels.get(channelName);
      if (!channelClients || !channelClients.has(ws)) return;
      for (const client of channelClients) {
        if (client !== ws) send(client, data);
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    for (const [channelName, clients] of channels) {
      if (clients.has(ws)) {
        clients.delete(ws);
        for (const client of clients) {
          send(client, { type: "system", message: "A user has left the channel", channel: channelName });
        }
      }
    }
  });
});

process.on("SIGINT", () => {
  console.log("\nShutting down AIConnect relay.");
  wss.close(() => process.exit(0));
});
