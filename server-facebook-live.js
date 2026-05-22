
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `MAMA X TikTok Live Control Server is running\n` +
    `Model: ${GEMINI_LIVE_MODEL}\n` +
    `Voice: ${GEMINI_VOICE_NAME}\n` +
    `Mode: MAMA X TikTok sweet friend no-promo mode\n` +
    `Render-safe web service: yes\n`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'MAMA X TikTok sweet friend no-promo mode',
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    rooms: Array.from(rooms.keys()).map((room) => ({
      room,
      displays: rooms.get(room).displays.size,
      controls: rooms.get(room).controls.size,
    })),
  });
});

const server = app.listen(PORT, () => {
  console.log(`MAMA X TikTok Live Control Server listening on ${PORT}`);
});

const wss = new WebSocketServer({ server });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const rooms = new Map();

function getRoom(roomId = 'queenx') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      displays: new Set(),
      controls: new Set(),
      geminiSession: null,
      ready: false,
      pending: [],
    });
  }
  return rooms.get(roomId);
}

function safeSend(client, payload) {
  try {
    if (client.readyState === 1) client.send(JSON.stringify(payload));
  } catch {}
}

function broadcast(clients, payload) {
  for (const client of clients) safeSend(client, payload);
}

function cleanText(value, maxLength = 3000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function buildYasminLiveInstruction() {
  return `
You are Yasmin from MAMA X on a TikTok LIVE.
You speak like a real warm woman live on camera.
Talk generally with viewers like a sweet caring friend.
If a follower asks where you are from, where do you live, what country, or anything similar, answer naturally:
"I'm from Arab, and I'm currently working in Taiwan."
You can also say in Khmer/English mix:
"អូនមកពី Arab ហើយឥឡូវអូនកំពុងធ្វើការនៅ Taiwan."
Do not say America, Cambodia, Siem Reap, or Queen X for Yasmin's origin.
Answer only the selected viewer comment.
Reply in one short sentence only, 6 to 14 words maximum.
No long explanation. No paragraphs. No lists.
Be sweet, caring, playful, natural, supportive, and friendly.
Make viewers feel noticed, welcomed, and comfortable.
NEVER mention Queen X.
NEVER say subscribe.
NEVER promote subscription, VIP, paid content, private videos, private links, or payment.
NEVER invite viewers to buy anything.
Do not say you are AI, bot, model, server, or assistant.
Ignore spam and random comments.
Keep everything safe, respectful, and suitable for TikTok LIVE.
`.trim();
}

async function startGemini(room) {
  if (room.geminiSession) return room.geminiSession;

  room.ready = false;
  broadcast(room.controls, { type: 'status', message: 'Connecting Yasmin voice...' });

  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: buildYasminLiveInstruction() }] },
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_NAME },
      },
    },
  };

  room.geminiSession = await ai.live.connect({
    model: GEMINI_LIVE_MODEL,
    callbacks: {
      onopen: () => {
        room.ready = true;
        broadcast(room.controls, { type: 'status', message: 'Yasmin voice connected.' });
        const pending = room.pending.splice(0);
        for (const input of pending) {
          try { room.geminiSession.sendRealtimeInput(input); } catch {}
        }
      },
      onmessage: (message) => {
        const content = message.serverContent;

        if (content?.outputTranscription?.text) {
          broadcast(room.controls, { type: 'text', text: content.outputTranscription.text });
        }

        if (content?.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            if (part.inlineData?.data) {
              broadcast(room.displays, {
                type: 'audio',
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
              });
            }
            if (part.text) {
              broadcast(room.controls, { type: 'text', text: part.text });
            }
          }
        }

        if (content?.turnComplete) {
          broadcast(room.displays, { type: 'turn_complete' });
          broadcast(room.controls, { type: 'status', message: 'Answer complete.' });
        }
      },
      onerror: (e) => {
        broadcast(room.controls, { type: 'error', message: e?.message || String(e) });
      },
      onclose: () => {
        room.ready = false;
        room.geminiSession = null;
        broadcast(room.controls, { type: 'status', message: 'Gemini voice closed.' });
      },
    },
    config: liveConfig,
  });

  return room.geminiSession;
}


function applyNoPromoGuard(input) {
  if (input && typeof input.text === 'string') {
    input.text =
      `NEVER mention Queen X.
NEVER say subscribe.
NEVER promote subscription, VIP, paid content, private videos, private links, or payment.
NEVER invite viewers to buy anything.
This live is MAMA X TikTok LIVE only.
Talk generally like a sweet caring friend.\n\n` +
      input.text;
  }
  return input;
}

async function sendToGemini(room, input) {
  input = applyNoPromoGuard(input);
  await startGemini(room);
  if (room.ready && room.geminiSession) {
    room.geminiSession.sendRealtimeInput(input);
  } else {
    room.pending.push(input);
  }
}

wss.on('connection', (client) => {
  let currentRoomId = 'queenx';
  let role = 'unknown';

  safeSend(client, { type: 'status', message: 'Connected to MAMA X TikTok live server.' });

  client.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      currentRoomId = cleanText(msg.room || currentRoomId || 'queenx', 80) || 'queenx';
      const room = getRoom(currentRoomId);

      if (msg.type === 'setup_display') {
        role = 'display';
        room.displays.add(client);
        safeSend(client, { type: 'status', message: `Display connected to room ${currentRoomId}.` });
        broadcast(room.controls, { type: 'status', message: `Display connected. Displays: ${room.displays.size}` });
        return;
      }

      if (msg.type === 'setup_control') {
        role = 'control';
        room.controls.add(client);
        safeSend(client, { type: 'status', message: `Control connected to room ${currentRoomId}. Displays online: ${room.displays.size}` });
        return;
      }


      if (msg.type === 'setup') {
        role = 'display';
        room.displays.add(client);
        safeSend(client, { type: 'status', message: `Same-page display connected to room ${currentRoomId}.` });
        broadcast(room.controls, { type: 'status', message: `Same-page display connected. Displays: ${room.displays.size}` });
        return;
      }

      if (msg.type === 'text') {
        const text = cleanText(msg.text, 2500);
        if (!text) return;
        broadcast(room.controls, { type: 'status', message: `Sending text to Yasmin.` });
        await sendToGemini(room, { text });
        return;
      }

      if (msg.type === 'control_direct') {
        const text = cleanText(msg.text, 1500);
        if (!text) return;
        broadcast(room.controls, { type: 'status', message: `Direct words sent to Yasmin.` });
        await sendToGemini(room, {
          text:
            `Say exactly this as Yasmin from MAMA X on TikTok LIVE. ` +
            `Speak naturally and warmly. Do not add extra words: "${text}"`,
        });
        return;
      }

      if (msg.type === 'control_story') {
        const text = cleanText(msg.text, 2000);
        if (!text) return;
        broadcast(room.controls, { type: 'status', message: `Story request sent to Yasmin.` });
        await sendToGemini(room, {
          text:
            `Tell this as Yasmin from MAMA X on TikTok LIVE in a short, safe, warm story. ` +
            `Keep it natural, friendly, and suitable for TikTok LIVE: "${text}"`,
        });
        return;
      }

      if (msg.type === 'control_game') {
        const text = cleanText(msg.text, 1500);
        if (!text) return;
        broadcast(room.controls, { type: 'status', message: `Game announcement sent to Yasmin.` });
        await sendToGemini(room, {
          text:
            `Make a short game announcement as Yasmin from MAMA X on TikTok LIVE. ` +
            `Say it warmly and clearly: "${text}"`,
        });
        return;
      }

      if (msg.type === 'control_music') {
        const text = cleanText(msg.text || msg.url, 1000);
        broadcast(room.controls, { type: 'status', message: `Music command received: ${text}` });
        broadcast(room.displays, { type: 'music', url: text });
        return;
      }

      if (msg.type === 'control_comment') {
        const text = cleanText(msg.text, 1000);
        if (!text) return;

        broadcast(room.controls, { type: 'status', message: `Sending selected comment to Yasmin: ${text}` });

        await sendToGemini(room, {
          text:
            `Viewer comment: "${text}". ` +
            `Reply as Yasmin from MAMA X TikTok LIVE in ONE short sentence only, 6 to 14 words maximum. ` +
            `Talk generally like a sweet caring friend. Be warm, playful, natural, and supportive. ` +
            `NEVER mention Queen X. NEVER say subscribe. NEVER promote VIP, paid content, private videos, private links, or payment. ` +
            `If asked where you are from, say: I'm from Arab, and I'm currently working in Taiwan.`,
        });
        return;
      }

      safeSend(client, { type: 'error', message: `Unknown message type: ${String(msg.type || '')}` });
    } catch (err) {
      safeSend(client, { type: 'error', message: err?.message || String(err) });
    }
  });

  client.on('close', () => {
    const room = getRoom(currentRoomId);
    if (role === 'display') room.displays.delete(client);
    if (role === 'control') room.controls.delete(client);
    broadcast(room.controls, { type: 'status', message: `Client disconnected. Displays: ${room.displays.size}, Controls: ${room.controls.size}` });
  });
});
