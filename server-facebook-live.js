/*
  Yasmin TikTok / TikFinity Auto Bot - Auto Port Finder
  LOCAL PC ONLY. Do not deploy this file to Render.
  It listens to TikFinity Desktop WebSocket and sends selected comments to QueenX live server.
*/

const fs = require("fs");
const WebSocket = require("ws");

function loadEnvFile() {
  const p = ".env";
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}
loadEnvFile();

function parseList(value) {
  return String(value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

const PORTS = parseList(process.env.TIKFINITY_PORTS || "21213,21214,21215,21216,21217,21218,21219,21220,21212");
const MANUAL_TIKFINITY_WS = String(process.env.TIKFINITY_WS || "").trim();

const CONFIG = {
  queenxWs: process.env.QUEENX_WS || "wss://queenx-live.onrender.com",
  room: process.env.ROOM || "queenx",
  character: process.env.CHARACTER || "yasmin",
  language: (process.env.LANGUAGE || "auto").toLowerCase(),
  cooldownMs: Math.max(3, Number(process.env.COOLDOWN_SECONDS || 8)) * 1000,
  triggerWords: parseList(process.env.TRIGGER_WORDS).map(s => s.toLowerCase()),
  ignoreUsers: new Set(parseList(process.env.IGNORE_USERS).map(s => s.toLowerCase())),
  dryRun: String(process.env.DRY_RUN || "false").toLowerCase() === "true",
  maxQueue: Math.max(20, Number(process.env.MAX_QUEUE || 80)),
};

let queenWs = null;
let tikWs = null;
let queenReady = false;
let tikfinityUrl = "";
let currentPortIndex = 0;
let lastSentAt = 0;
let queue = [];
let recent = new Map();
let reconnectTikTimer = null;

const badWords = [
  "kill yourself", "suicide", "terrorist", "bomb", "drug", "nude", "porn",
  "sex", "onlyfans", "hack", "scam", "password", "api key"
];

function log(...args) {
  console.log(new Date().toLocaleTimeString(), "-", ...args);
}

function languageInstruction() {
  if (CONFIG.language === "khmer") return "Reply in Khmer naturally.";
  if (CONFIG.language === "english") return "Reply in English naturally.";
  if (CONFIG.language === "thai") return "Reply in Thai naturally.";
  if (CONFIG.language === "indonesian") return "Reply in Indonesian naturally.";
  return [
    "Match the viewer's language when possible.",
    "Supported languages: Khmer, English, Thai, Indonesian, Chinese, Spanish, Arabic.",
    "If unsure, reply in simple English."
  ].join(" ");
}

function yasminPrompt(user, comment) {
  return [
    languageInstruction(),
    "",
    "You are Yasmin from MAMA X TikTok LIVE.",
    "Answer viewer comments like a real livestream host.",
    "Keep the answer short: one sentence only, 6 to 16 words maximum.",
    "Be sweet, friendly, playful, natural, supportive, and fun, like a caring friend.",
    "Make viewers feel noticed, welcomed, and comfortable.",
    "Do not say you are AI, bot, virtual, model, server, or assistant.",
    "Do not promote subscription, VIP, Queen X, MAMA X paid content, private videos, or links. Just talk generally like a sweet friend.",
    "Do not answer unsafe, hateful, illegal, or explicit requests.",
    "",
    `Viewer @${user} commented: ${comment}`,
    "",
    "Yasmin, reply to this viewer now."
  ].join("\n");
}

function extractText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const candidates = [
    obj.comment, obj.message, obj.text, obj.msg, obj.commentText,
    obj.data?.comment, obj.data?.message, obj.data?.text, obj.data?.msg, obj.data?.commentText,
    obj.payload?.comment, obj.payload?.message, obj.payload?.text,
    obj.event?.comment, obj.event?.message, obj.event?.text,
    obj.commandParams, obj.data?.commandParams
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function extractUser(obj) {
  if (!obj || typeof obj !== "object") return "viewer";
  const candidates = [
    obj.username, obj.uniqueId, obj.nickname, obj.user, obj.userId,
    obj.data?.username, obj.data?.uniqueId, obj.data?.nickname, obj.data?.user, obj.data?.userId,
    obj.payload?.username, obj.payload?.uniqueId, obj.payload?.nickname,
    obj.event?.username, obj.event?.uniqueId, obj.event?.nickname,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().replace(/^@/, "");
    if (c && typeof c === "object") {
      if (typeof c.uniqueId === "string") return c.uniqueId.replace(/^@/, "");
      if (typeof c.nickname === "string") return c.nickname.replace(/^@/, "");
      if (typeof c.username === "string") return c.username.replace(/^@/, "");
      if (typeof c.userId === "string") return c.userId.replace(/^@/, "");
    }
  }
  return "viewer";
}

function eventName(obj) {
  const candidates = [
    obj.type, obj.event, obj.eventName, obj.name,
    obj.data?.type, obj.data?.event, obj.data?.eventName,
    obj.payload?.type, obj.payload?.event
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.toLowerCase();
  }
  return "";
}

function isChatEvent(obj) {
  const ev = eventName(obj);
  if (["chat", "comment", "chatmessage", "chat_message", "message", "livecomment"].includes(ev)) return true;
  const text = extractText(obj);
  if (!text) return false;
  const nonChatWords = ["gift", "like", "follow", "share", "member", "join", "viewer", "subscribe", "roomuser"];
  if (nonChatWords.some(w => ev.includes(w))) return false;
  return true;
}

function shouldAnswer(user, text) {
  const cleanUser = String(user || "").toLowerCase();
  if (CONFIG.ignoreUsers.has(cleanUser)) return false;

  const t = String(text || "").trim();
  if (t.length < 2 || t.length > 220) return false;

  const low = t.toLowerCase();
  if (badWords.some(w => low.includes(w))) return false;
  if (/https?:\/\//i.test(t)) return false;
  if ((low.match(/(.)\1{8,}/) || []).length) return false;

  const key = cleanUser + "|" + low;
  if (recent.has(key) && Date.now() - recent.get(key) < 5 * 60 * 1000) return false;
  recent.set(key, Date.now());

  for (const [k, v] of recent.entries()) {
    if (Date.now() - v > 10 * 60 * 1000) recent.delete(k);
  }

  if (!CONFIG.triggerWords.length) return true;
  return CONFIG.triggerWords.some(w => low.includes(w));
}

function connectQueenX() {
  log("Connecting QueenX:", CONFIG.queenxWs);
  queenWs = new WebSocket(CONFIG.queenxWs);

  queenWs.on("open", () => {
    queenReady = true;
    log("QueenX connected ✅ Room:", CONFIG.room);
    try {
      queenWs.send(JSON.stringify({
        type: "setup_control",
        room: CONFIG.room,
        character: CONFIG.character
      }));
    } catch (_) {}
    flushQueue();
  });

  queenWs.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.type === "status") log("QueenX status:", m.message || "");
      if (m.type === "error") log("QueenX error:", m.message || JSON.stringify(m));
    } catch (_) {}
  });

  queenWs.on("close", () => {
    queenReady = false;
    log("QueenX disconnected. Reconnecting in 3 seconds...");
    setTimeout(connectQueenX, 3000);
  });

  queenWs.on("error", (err) => log("QueenX WS error:", err.message));
}

function sendToYasmin(user, text) {
  const payload = {
    type: "control_comment",
    room: CONFIG.room,
    character: CONFIG.character,
    text: yasminPrompt(user, text)
  };

  if (CONFIG.dryRun) {
    log("DRY RUN would send:", JSON.stringify(payload, null, 2));
    return;
  }

  if (!queenReady || !queenWs || queenWs.readyState !== WebSocket.OPEN) {
    log("QueenX not ready, queued comment:", user, text);
    queue.push({ user, text, time: Date.now() });
    if (queue.length > CONFIG.maxQueue) queue.shift();
    return;
  }

  queenWs.send(JSON.stringify(payload));
  lastSentAt = Date.now();
  log(`Sent to Yasmin ✅ @${user}: ${text}`);
}

function flushQueue() {
  if (!queue.length) return;
  const now = Date.now();
  if (now - lastSentAt < CONFIG.cooldownMs) return;
  const item = queue.shift();
  if (!item) return;
  sendToYasmin(item.user, item.text);
}
setInterval(flushQueue, 500);

function handleChat(user, text) {
  log(`TikTok comment @${user}: ${text}`);
  if (!shouldAnswer(user, text)) {
    log("Ignored by filters/duplicates/trigger words.");
    return;
  }
  if (Date.now() - lastSentAt < CONFIG.cooldownMs) {
    queue.push({ user, text, time: Date.now() });
    if (queue.length > CONFIG.maxQueue) queue.shift();
    log("Queued for cooldown. Queue:", queue.length);
    return;
  }
  sendToYasmin(user, text);
}

function nextTikfinityUrl() {
  if (MANUAL_TIKFINITY_WS) return MANUAL_TIKFINITY_WS;
  const port = PORTS[currentPortIndex % PORTS.length];
  currentPortIndex++;
  return `ws://127.0.0.1:${port}/`;
}

function scheduleTikReconnect() {
  clearTimeout(reconnectTikTimer);
  reconnectTikTimer = setTimeout(connectTikFinity, 3000);
}

function connectTikFinity() {
  const url = nextTikfinityUrl();
  tikfinityUrl = url;
  log("Connecting TikFinity:", url);

  try {
    tikWs = new WebSocket(url);
  } catch (err) {
    log("TikFinity create socket error:", err.message);
    scheduleTikReconnect();
    return;
  }

  let opened = false;

  tikWs.on("open", () => {
    opened = true;
    log("TikFinity connected ✅ Waiting for LIVE comments...");
    log("Using TikFinity URL:", url);
  });

  tikWs.on("message", (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); }
    catch {
      log("TikFinity raw:", raw.slice(0, 300));
      return;
    }
    if (!isChatEvent(msg)) return;
    const text = extractText(msg);
    const user = extractUser(msg);
    if (!text) return;
    handleChat(user, text);
  });

  tikWs.on("close", () => {
    if (opened) {
      log("TikFinity disconnected. Reconnecting in 3 seconds...");
    } else {
      log("TikFinity not found on", url, "trying next port in 3 seconds...");
    }
    scheduleTikReconnect();
  });

  tikWs.on("error", (err) => {
    log("TikFinity WS error:", err.message);
    log("Open TikFinity Desktop, connect it to your TikTok LIVE, then enable WebSocket/Event API.");
    log("This bot will auto-try ports:", PORTS.join(", "));
  });
}

function testMode() {
  const idx = process.argv.indexOf("--test");
  if (idx === -1) return false;
  const testText = process.argv.slice(idx + 1).join(" ") || "Hello Yasmin";
  connectQueenX();
  setTimeout(() => sendToYasmin("test_viewer", testText), 2000);
  return true;
}

log("Yasmin TikTok Auto Bot MAMA X SWEET FRIEND MODE starting...");
log("Settings:", {
  queenxWs: CONFIG.queenxWs,
  room: CONFIG.room,
  language: CONFIG.language,
  cooldownSeconds: CONFIG.cooldownMs / 1000,
  triggerWords: CONFIG.triggerWords.length ? CONFIG.triggerWords : "EMPTY = answer more comments",
  manualTikfinityWs: MANUAL_TIKFINITY_WS || "none",
  tikfinityPorts: PORTS,
  dryRun: CONFIG.dryRun
});

if (!testMode()) {
  connectQueenX();
  connectTikFinity();
}
