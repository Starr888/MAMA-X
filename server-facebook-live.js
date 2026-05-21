/*
  QueenX / Yasmin Live WebSocket Server - Render Ready
  ----------------------------------------------------
  This file runs on Render as your WebSocket hub.

  - Browser Control Center connects to: wss://YOUR-RENDER-APP.onrender.com
  - Yasmin Live page connects to the same URL and same room
  - Local AutoPilot bot connects to the same URL and sends control_comment
  - Render health check works because this file listens on process.env.PORT
*/

const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ROOM = process.env.ROOM || "queenx";
const DEFAULT_CHARACTER = process.env.CHARACTER || "yasmin";

const rooms = new Map(); // room -> Set<WebSocket>
let totalConnections = 0;
let lastMessageAt = null;

function log(...args) {
  console.log(new Date().toLocaleString(), "-", ...args);
}

function safeJsonParse(data) {
  try {
    return JSON.parse(data.toString());
  } catch (_) {
    return null;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getRoomName(msg, ws) {
  return String(msg?.room || ws.room || DEFAULT_ROOM).trim() || DEFAULT_ROOM;
}

function addToRoom(ws, room) {
  room = String(room || DEFAULT_ROOM).trim() || DEFAULT_ROOM;

  if (ws.room && rooms.has(ws.room)) {
    rooms.get(ws.room).delete(ws);
    if (rooms.get(ws.room).size === 0) rooms.delete(ws.room);
  }

  ws.room = room;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
}

function roomCount(room) {
  return rooms.has(room) ? rooms.get(room).size : 0;
}

function broadcast(room, obj, exceptWs = null) {
  const clients = rooms.get(room);
  if (!clients) return 0;

  let count = 0;
  for (const client of clients) {
    if (client === exceptWs) continue;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(obj));
      count += 1;
    }
  }
  return count;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status") {
    res.end(JSON.stringify({
      ok: true,
      service: "queenx-yasmin-websocket-server",
      websocket: true,
      connectUrl: "wss://" + (req.headers.host || "YOUR-RENDER-APP.onrender.com"),
      defaultRoom: DEFAULT_ROOM,
      defaultCharacter: DEFAULT_CHARACTER,
      rooms: Array.from(rooms.entries()).map(([room, clients]) => ({ room, clients: clients.size })),
      totalConnections,
      lastMessageAt,
      uptimeSeconds: Math.round(process.uptime())
    }, null, 2));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  totalConnections += 1;

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const room = url.searchParams.get("room") || DEFAULT_ROOM;
  const character = url.searchParams.get("character") || DEFAULT_CHARACTER;

  ws.id = Math.random().toString(36).slice(2, 10);
  ws.character = character;
  ws.role = "unknown";
  ws.isAlive = true;

  addToRoom(ws, room);

  log(`WS connected ${ws.id} room=${ws.room} clients=${roomCount(ws.room)}`);

  send(ws, {
    type: "status",
    ok: true,
    message: "Connected to QueenX WebSocket server ✅",
    room: ws.room,
    character: ws.character,
    clients: roomCount(ws.room)
  });

  broadcast(ws.room, {
    type: "status",
    message: `Client connected to room ${ws.room}`,
    room: ws.room,
    clients: roomCount(ws.room)
  }, ws);

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg || typeof msg !== "object") {
      send(ws, { type: "error", message: "Invalid JSON message" });
      return;
    }

    const type = String(msg.type || "").trim();
    const msgRoom = getRoomName(msg, ws);
    if (msgRoom !== ws.room) addToRoom(ws, msgRoom);

    if (msg.character) ws.character = String(msg.character);
    lastMessageAt = new Date().toISOString();

    // Control Center joins with setup_control.
    if (type === "setup_control") {
      ws.role = "control";
      send(ws, {
        type: "status",
        ok: true,
        message: "Control connected ✅",
        room: ws.room,
        character: ws.character,
        clients: roomCount(ws.room)
      });
      return;
    }

    // Live page can join with setup_live / join_live / live_ready.
    if (["setup_live", "join_live", "live_ready"].includes(type)) {
      ws.role = "live";
      send(ws, {
        type: "status",
        ok: true,
        message: "Live connected ✅",
        room: ws.room,
        character: ws.character,
        clients: roomCount(ws.room)
      });
      return;
    }

    // Keep ping compatibility.
    if (type === "ping") {
      send(ws, { type: "pong", time: Date.now(), room: ws.room });
      return;
    }

    // Main compatible message: all buttons and AutoPilot send control_comment.
    if (type === "control_comment") {
      const text = String(msg.text || msg.comment || msg.message || "").trim();
      if (!text) {
        send(ws, { type: "error", message: "control_comment missing text" });
        return;
      }

      const payload = {
        type: "control_comment",
        room: ws.room,
        character: String(msg.character || ws.character || DEFAULT_CHARACTER),
        text,
        source: ws.role || "control",
        time: Date.now()
      };

      const delivered = broadcast(ws.room, payload, null);
      send(ws, {
        type: "status",
        ok: true,
        message: `Sent to room ${ws.room} ✅`,
        delivered,
        room: ws.room
      });

      log(`control_comment room=${ws.room} delivered=${delivered} text=${text.slice(0, 80)}`);
      return;
    }

    // Backward compatibility: rebroadcast older control types too.
    if (["control_direct", "direct_words", "talk", "say", "story", "game"].includes(type)) {
      const payload = { ...msg, room: ws.room, character: msg.character || ws.character || DEFAULT_CHARACTER, time: Date.now() };
      const delivered = broadcast(ws.room, payload, null);
      send(ws, { type: "status", ok: true, message: `Broadcast ${type} ✅`, delivered, room: ws.room });
      return;
    }

    // Unknown message: do not crash; tell sender.
    send(ws, {
      type: "error",
      message: `Unknown message type: ${type || "missing"}`,
      room: ws.room
    });
  });

  ws.on("close", () => {
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      if (rooms.get(ws.room).size === 0) rooms.delete(ws.room);
    }
    log(`WS disconnected ${ws.id} room=${ws.room || DEFAULT_ROOM}`);
  });

  ws.on("error", (err) => {
    log(`WS error ${ws.id}:`, err.message);
  });
});

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);

wss.on("close", () => clearInterval(pingTimer));

server.listen(PORT, "0.0.0.0", () => {
  log(`QueenX Yasmin WebSocket server running on 0.0.0.0:${PORT} ✅`);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err && err.stack ? err.stack : err);
});
