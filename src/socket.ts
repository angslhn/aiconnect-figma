#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Prakhar Gupta.

import { Server, ServerWebSocket } from "bun";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || process.env.AICONNECT_RELAY_PORT || 3055);
// Loopback only by default; override with AICONNECT_RELAY_HOST at your own risk.
const HOST = process.env.AICONNECT_RELAY_HOST || "127.0.0.1";

// Shared relay token (main auth layer — a sandboxed web iframe also sends
// Origin "null", so Origin checks alone can't identify the plugin).
// Same precedence/file as the Node relay and MCP server.
const TOKEN_FILE = join(homedir(), ".aiconnect-relay-token");
function getToken(): string {
  const fromEnv = (process.env.AICONNECT_RELAY_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) { lockTokenFileWin(TOKEN_FILE); return saved; }
  } catch { /* first run */ }
  const fresh = randomBytes(32).toString("hex");
  try {
    writeFileSync(TOKEN_FILE, fresh + "\n", { mode: 0o600 });
  } catch (err) {
    console.error("Could not persist relay token:", err);
  }
  lockTokenFileWin(TOKEN_FILE);
  return fresh;
}

// Windows: mode 0o600 is a no-op there, so best-effort restrict the token
// file to the current user via icacls. Never throws, never blocks startup.
function lockTokenFileWin(file: string): void {
  if (process.platform !== "win32") return;
  try {
    const user = (process.env.USERNAME || "").trim();
    if (!user || !existsSync(file)) return;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch { /* best-effort only */ }
}
const TOKEN = getToken();

// Constant-time token comparison (never `===` on secrets).
function tokensEqual(presented: string | null, expected: string): boolean {
  const a = Buffer.from(presented || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();
// Most recently joined channel — lets the MCP server auto-discover the plugin.
let lastJoinedChannel: string | null = null;

function handleConnection(ws: ServerWebSocket<any>) {
  // Don't add to clients immediately - wait for channel join
  console.log("New client connected");

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));

  ws.close = () => {
    console.log("Client disconnected");

    // Remove client from their channel
    channels.forEach((clients, channelName) => {
      if (clients.has(ws)) {
        clients.delete(ws);

        // Notify other clients in same channel
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "system",
              message: "A user has left the channel",
              channel: channelName
            }));
          }
        });
      }
    });
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // uncomment this to allow connections in windows wsl
  // hostname: "0.0.0.0",
  fetch(req: Request, server: Server) {
    // Handshake gate (wire message format untouched):
    // reject web Origins, require ?token=. Missing Origin (Node clients)
    // and "null" (Figma plugin iframe) are allowed through to the token check.
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";
    if (origin && origin !== "null") {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (!tokensEqual(url.searchParams.get("token"), TOKEN)) {
      return new Response("Unauthorized relay token", { status: 401 });
    }
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle WebSocket upgrade
    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        const data = JSON.parse(message as string);
        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        if (data.type === "list_channels") {
          const active = [...channels.entries()].filter(([, s]) => s.size > 0).map(([name]) => name);
          ws.send(JSON.stringify({ type: "channels", channels: active, lastJoined: lastJoinedChannel }));
          return;
        }

        if (data.type === "join") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);
          lastJoinedChannel = channelName;

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!channelName || typeof channelName !== "string") {
            ws.send(JSON.stringify({
              type: "error",
              message: "Channel name is required"
            }));
            return;
          }

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        console.error("Error handling message:", err);
      }
    },
    close(ws: ServerWebSocket<any>) {
      // Remove client from their channel
      channels.forEach((clients) => {
        clients.delete(ws);
      });
    }
  }
});

console.log(`WebSocket server running on ws://${HOST}:${server.port} (loopback only unless AICONNECT_RELAY_HOST is set)`);
console.log(`Relay token stored at ${TOKEN_FILE} — paste it into the Figma plugin's "Relay token" field once.`);
