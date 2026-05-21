/*
  Yasmin TikTok Auto Bot - More Reply Mode
  TikFinity LIVE comments -> QueenX Render WebSocket -> Yasmin speaks on live page.
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

const CONFIG = {
  tikfinityWs: process.env.TIKFINITY_WS || "ws://127.0.0.1:21213/",
  queenxWs: process.env.QUEENX_WS || "wss://queenx-live.onrender.com",
  room: process.env.ROOM || "queenx",
  character: process.env.CHARACTER || "yasmin",
  language: (process.env.LANGUAGE || "no_khmer_multilang").toLowerCase(),
  cooldownMs: Math.max(3, Number(process.env.COOLDOWN_SECONDS || 8)) * 1000,
  triggerWords: (process.env.TRIGGER_WORDS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  ignoreUsers: new Set((process.env.IGNORE_USERS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)),
  dryRun: String(process.env.DRY_RUN || "false").toLowerCase() === "true",
  maxQueue: Math.max(20, Number(process.env.MAX_QUEUE || 60)),
};

let queenWs = null;
let tikWs = null;
let queenReady = false;
let lastSentAt = 0;
let queue = [];
let recent = new Map();

const badWords = [
  "kill yourself", "suicide", "terrorist", "bomb", "drug", "nude", "porn",
  "sex", "onlyfans", "hack", "scam", "password", "api key"
];

function log(...args) {
  console.log(new Date().toLocaleTimeString(), "-", ...args);
}

function languageInstruction() {
  if (CONFIG.language === "english") {
    return "Reply in English naturally. Do not speak Khmer.";
  }

  return [
    "Do NOT speak Khmer.",
    "Use only English, Thai, Indonesian, Spanish, Arabic, or Chinese.",
    "Match the viewer's language if it is one of those languages.",
    "If the viewer writes Khmer or an unsupported language, reply in simple English.",
    "If the viewer asks where you are from, say: I'm Arab, currently living in Taiwan."
  ].join(" ");
}

function yasminPrompt(user, comment) {
  return [
    languageInstruction(),
    "",
    "You are Yasmin from MAMA X TikTok LIVE.",
    "Answer viewer comments like a real livestream host.",
    "Keep the answer short: one sentence only, 6 to 16 words maximum.",
    "Be sweet, friendly, playful, natural, and fun.",
    "Make viewers feel noticed so they keep watching.",
    "Do not say you are AI, bot, virtual, model, server, or assistant.",
    "Do not promote subscription, VIP, Queen X, or private videos unless the viewer directly asks.",
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
    obj.comment, obj.message, obj.text, obj.msg,
    obj.data?.comment, obj.data?.message, obj.data?.text, obj.data?.msg,
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
    obj.username, obj.uniqueId, obj.nickname, obj.user,
    obj.data?.username, obj.data?.uniqueId, obj.data?.nickname, obj.data?.user,
    obj.payload?.username, obj.payload?.uniqueId, obj.payload?.nickname,
    obj.event?.username, obj.event?.uniqueId, obj.event?.nickname,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().replace(/^@/, "");
    if (c && typeof c === "object") {
      if (typeof c.uniqueId === "string") return c.uniqueId.replace(/^@/, "");
      if (typeof c.nickname === "string") return c.nickname.replace(/^@/, "");
      if (typeof c.username === "string") return c.username.replace(/^@/, "");
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
  if (["chat", "comment", "chatmessage", "chat_message", "message"].includes(ev)) return true;
  const text = extractText(obj);
  if (!text) return false;
  const nonChatWords = ["gift", "like", "follow", "share", "member", "join", "viewer", "subscribe"];
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

  // More Reply Mode: if TRIGGER_WORDS is empty, answer almost all normal chat comments.
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

function connectTikFinity() {
  log("Connecting TikFinity:", CONFIG.tikfinityWs);
  tikWs = new WebSocket(CONFIG.tikfinityWs);

  tikWs.on("open", () => log("TikFinity connected ✅ Waiting for LIVE comments..."));

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
    log("TikFinity disconnected. Reconnecting in 3 seconds...");
    setTimeout(connectTikFinity, 3000);
  });

  tikWs.on("error", (err) => {
    log("TikFinity WS error:", err.message);
    log("Make sure TikFinity Desktop is open and connected to your LIVE. Default port is usually 21213.");
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

log("Yasmin TikTok Auto Bot MORE REPLY starting...");
log("Settings:", {
  tikfinityWs: CONFIG.tikfinityWs,
  queenxWs: CONFIG.queenxWs,
  room: CONFIG.room,
  language: CONFIG.language,
  cooldownSeconds: CONFIG.cooldownMs / 1000,
  triggerWords: CONFIG.triggerWords.length ? CONFIG.triggerWords : "EMPTY = answer more comments",
  dryRun: CONFIG.dryRun
});

if (!testMode()) {
  connectQueenX();
  connectTikFinity();
}
