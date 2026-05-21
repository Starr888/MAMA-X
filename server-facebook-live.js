/*
  Yasmin TikTok Auto Bot - Render + Local Fixed Version
  File name for GitHub/Render: server-facebook-live.js

  FIXES:
  - Adds an HTTP health server so Render Web Service does NOT fail because no PORT is open.
  - Keeps QueenX WebSocket connection alive.
  - Can run AutoTalk by itself.
  - Can connect to TikFinity comments when running on your Windows PC.
  - On Render, TikFinity is disabled by default because Render cannot reach ws://127.0.0.1:21213 on your PC.
*/

const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err && err.stack ? err.stack : err);
});

function loadEnvFile() {
  if (!fs.existsSync(".env")) return;
  const raw = fs.readFileSync(".env", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}
loadEnvFile();

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

const IS_RENDER = String(process.env.RENDER || "").toLowerCase() === "true" ||
  Boolean(process.env.RENDER_SERVICE_ID);

const CONFIG = {
  port: Number(process.env.PORT || 10000),

  tikfinityWs: process.env.TIKFINITY_WS || "ws://127.0.0.1:21213/",
  queenxWs: process.env.QUEENX_WS || "wss://queenx-live.onrender.com",

  room: process.env.ROOM || "queenx",
  character: process.env.CHARACTER || "yasmin",
  language: (process.env.LANGUAGE || "no_khmer_multilang").toLowerCase(),

  commentCooldownMs: Math.max(3, Number(process.env.COMMENT_COOLDOWN_SECONDS || 8)) * 1000,
  autoTalk: boolEnv("AUTO_TALK", true),
  autoTalkEveryMs: Math.max(15, Number(process.env.AUTO_TALK_EVERY_SECONDS || 45)) * 1000,
  autoTalkNoCommentMs: Math.max(5, Number(process.env.AUTO_TALK_ONLY_AFTER_NO_COMMENT_SECONDS || 20)) * 1000,

  autoTopics: (process.env.AUTO_TOPICS || "history,woman_beauty,love,taiwan,travel,music,daily_life,fun_question")
    .split(",").map(s => s.trim()).filter(Boolean),

  triggerWords: (process.env.TRIGGER_WORDS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),

  ignoreUsers: new Set((process.env.IGNORE_USERS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)),

  dryRun: boolEnv("DRY_RUN", false),
  maxQueue: Math.max(20, Number(process.env.MAX_QUEUE || 80)),

  // Important:
  // Render cannot connect to TikFinity Desktop on your PC at 127.0.0.1.
  // So on Render this defaults to false.
  // On your Windows PC this defaults to true.
  runTikfinity: boolEnv("RUN_TIKFINITY", !IS_RENDER),
};

let queenWs = null;
let tikWs = null;
let queenReady = false;
let lastSentAt = 0;
let lastCommentAt = 0;
let lastAutoTalkAt = 0;
let queue = [];
let recent = new Map();
let topicIndex = 0;

const badWords = [
  "kill yourself", "suicide", "terrorist", "bomb", "drug", "nude", "porn",
  "sex", "onlyfans", "hack", "scam", "password", "api key"
];

function log(...args) {
  console.log(new Date().toLocaleTimeString(), "-", ...args);
}

function jsonResponse(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data, null, 2));
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status") {
      return jsonResponse(res, 200, {
        ok: true,
        service: "yasmin-autopilot",
        file: "server-facebook-live.js",
        renderDetected: IS_RENDER,
        character: CONFIG.character,
        room: CONFIG.room,
        queenxConnected: queenReady,
        queueLength: queue.length,
        autoTalk: CONFIG.autoTalk,
        runTikfinity: CONFIG.runTikfinity,
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    // Manual test endpoint:
    // /say?text=Hello%20everyone
    if (url.pathname === "/say") {
      const text = (url.searchParams.get("text") || "").trim();
      if (!text) return jsonResponse(res, 400, { ok: false, error: "Missing text. Use /say?text=Hello" });
      sendTextToYasmin(
        baseYasminRules() + "\n\nSay this naturally now: " + text,
        "manual /say"
      );
      return jsonResponse(res, 200, { ok: true, queuedOrSent: true, text });
    }

    jsonResponse(res, 404, { ok: false, error: "Not found", use: ["/", "/health", "/status", "/say?text=Hello"] });
  });

  server.listen(CONFIG.port, "0.0.0.0", () => {
    log(`HTTP health server listening on 0.0.0.0:${CONFIG.port} ✅`);
  });

  server.on("error", (err) => {
    console.error("HTTP health server error:", err && err.stack ? err.stack : err);
  });
}

function validWsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "ws:" || u.protocol === "wss:";
  } catch (_) {
    return false;
  }
}

function languageInstruction() {
  return [
    "Do NOT speak Khmer.",
    "Use only English, Thai, Indonesian, Spanish, Arabic, or Chinese.",
    "Match the viewer's language if it is one of those languages.",
    "If the viewer writes Khmer or an unsupported language, reply in simple English.",
    "If the viewer asks where you are from, say: I'm Arab-style Yasmin, live from Taiwan tonight."
  ].join(" ");
}

function baseYasminRules() {
  return [
    languageInstruction(),
    "You are Yasmin from MAMA X TikTok LIVE.",
    "You are sweet, friendly, playful, feminine, fun, and natural.",
    "Talk like a real livestream host, not like an advertisement.",
    "Keep everything safe and suitable for TikTok LIVE.",
    "Never introduce yourself as AI, bot, virtual, model, server, or assistant.",
    "If someone asks if you are real, say you are really here live as Yasmin talking with them tonight.",
    "If someone directly asks if you are AI or a bot, answer honestly but warmly: I'm Yasmin, your live digital host, here talking with you now.",
    "Do not promote subscription, Queen X, VIP, or private videos unless the viewer directly asks.",
    "Use one short sentence only, 6 to 18 words maximum."
  ].join("\n");
}

function commentPrompt(user, comment) {
  return [
    baseYasminRules(),
    "",
    `Viewer @${user} commented: ${comment}`,
    "Reply directly to this viewer now."
  ].join("\n");
}

function autoTopicPrompt(topic) {
  const topicMap = {
    history: "Say one fun, simple, interesting history fact or history question. Avoid exact dates unless you are sure.",
    woman_beauty: "Share one sweet woman beauty tip about makeup, hair, fashion, skincare, or photo pose.",
    love: "Say one warm, sweet line about love, kindness, or romantic feelings, suitable for live stream.",
    taiwan: "Say one friendly line about daily life, food, travel, or beautiful places in Taiwan.",
    travel: "Say one fun travel question or travel dream for viewers.",
    music: "Say one sweet line asking viewers about music or songs they like.",
    daily_life: "Say one natural daily-life livestream line that makes viewers feel welcome.",
    fun_question: "Ask viewers one simple fun question to make them comment."
  };

  return [
    baseYasminRules(),
    "",
    "Speak by yourself to keep the live active.",
    topicMap[topic] || "Say one friendly livestream line to keep viewers watching.",
    "Do not mention that nobody is commenting.",
    "Do not ask people to subscribe.",
    "Make it sound spontaneous and real."
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

  if (!CONFIG.triggerWords.length) return true;
  return CONFIG.triggerWords.some(w => low.includes(w));
}

function connectQueenX() {
  if (!validWsUrl(CONFIG.queenxWs)) {
    log("QUEENX_WS is not a valid ws/wss URL:", CONFIG.queenxWs);
    return;
  }

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
    } catch (err) {
      log("QueenX setup send error:", err.message);
    }
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

function sendTextToYasmin(text, label = "comment") {
  const payload = {
    type: "control_comment",
    room: CONFIG.room,
    character: CONFIG.character,
    text
  };

  if (CONFIG.dryRun) {
    log("DRY RUN would send:", JSON.stringify(payload, null, 2));
    return;
  }

  if (!queenReady || !queenWs || queenWs.readyState !== WebSocket.OPEN) {
    log("QueenX not ready, queued:", label);
    queue.push({ text, label, time: Date.now() });
    if (queue.length > CONFIG.maxQueue) queue.shift();
    return;
  }

  queenWs.send(JSON.stringify(payload));
  lastSentAt = Date.now();
  log(`Sent to Yasmin ✅ (${label})`);
}

function sendCommentToYasmin(user, text) {
  sendTextToYasmin(commentPrompt(user, text), `comment @${user}: ${text}`);
}

function flushQueue() {
  if (!queue.length) return;

  const now = Date.now();
  if (now - lastSentAt < CONFIG.commentCooldownMs) return;

  const item = queue.shift();
  if (!item) return;
  sendTextToYasmin(item.text, item.label);
}
setInterval(flushQueue, 500);

function handleChat(user, text) {
  lastCommentAt = Date.now();
  log(`TikTok comment @${user}: ${text}`);

  if (!shouldAnswer(user, text)) {
    log("Ignored by filters/duplicates/trigger words.");
    return;
  }

  if (Date.now() - lastSentAt < CONFIG.commentCooldownMs) {
    queue.push({ text: commentPrompt(user, text), label: `queued comment @${user}: ${text}`, time: Date.now() });
    if (queue.length > CONFIG.maxQueue) queue.shift();
    log("Queued for cooldown. Queue:", queue.length);
    return;
  }

  sendCommentToYasmin(user, text);
}

function maybeAutoTalk() {
  if (!CONFIG.autoTalk) return;
  if (queue.length > 0) return;

  const now = Date.now();
  if (now - lastSentAt < CONFIG.commentCooldownMs) return;
  if (now - lastAutoTalkAt < CONFIG.autoTalkEveryMs) return;
  if (lastCommentAt && now - lastCommentAt < CONFIG.autoTalkNoCommentMs) return;

  const topic = CONFIG.autoTopics[topicIndex % CONFIG.autoTopics.length] || "daily_life";
  topicIndex += 1;
  lastAutoTalkAt = now;
  log("Autopilot topic:", topic);
  sendTextToYasmin(autoTopicPrompt(topic), `autopilot ${topic}`);
}
setInterval(maybeAutoTalk, 1000);

function connectTikFinity() {
  if (!CONFIG.runTikfinity) {
    log("TikFinity disabled on this machine. This is normal on Render.");
    log("Run START_YASMIN_AUTOPILOT_BOT.bat on your Windows PC for TikFinity comments.");
    return;
  }

  if (!validWsUrl(CONFIG.tikfinityWs)) {
    log("TIKFINITY_WS is not a valid ws/wss URL:", CONFIG.tikfinityWs);
    return;
  }

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
  if (!process.argv.includes("--test")) return false;
  connectQueenX();
  setTimeout(() => sendTextToYasmin(autoTopicPrompt("fun_question"), "test autopilot"), 2000);
  return true;
}

startHealthServer();

log("Yasmin TikTok Auto Bot AUTOPILOT starting...");
log("Settings:", {
  port: CONFIG.port,
  isRender: IS_RENDER,
  tikfinityWs: CONFIG.tikfinityWs,
  queenxWs: CONFIG.queenxWs,
  room: CONFIG.room,
  language: CONFIG.language,
  commentCooldownSeconds: CONFIG.commentCooldownMs / 1000,
  autoTalk: CONFIG.autoTalk,
  autoTalkEverySeconds: CONFIG.autoTalkEveryMs / 1000,
  autoTalkOnlyAfterNoCommentSeconds: CONFIG.autoTalkNoCommentMs / 1000,
  autoTopics: CONFIG.autoTopics,
  triggerWords: CONFIG.triggerWords.length ? CONFIG.triggerWords : "EMPTY = answer more comments",
  runTikfinity: CONFIG.runTikfinity,
  dryRun: CONFIG.dryRun
});

if (!testMode()) {
  connectQueenX();
  connectTikFinity();
}
