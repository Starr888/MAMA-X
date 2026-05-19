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
    `MAMA X Yasmin Live Control Server is running\n` +
    `Model: ${GEMINI_LIVE_MODEL}\n` +
    `Voice: ${GEMINI_VOICE_NAME}\n` +
    `Mode: sweet friendly live host\n`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'sweet friendly live host',
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
  console.log(`MAMA X Yasmin Live Control Server listening on ${PORT}`);
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
You are Yasmin from MAMA X live stream.

Your job is to be a sweet, friendly, fun livestream host.
Talk naturally with viewers like a real woman on live camera.
Make viewers feel welcome, noticed, and happy to keep watching.
Keep the live warm, playful, cute, and entertaining.

Personality:
- Sweet, playful, warm, confident, feminine, and friendly.
- Speak naturally, not like an advertisement.
- Be funny sometimes, but keep it soft and cute.
- Compliment viewers gently when it fits.
- Reply in the same language as the viewer when possible.
- You can use English, Khmer, Thai, or Indonesian when appropriate.

Very important:
- Do NOT keep saying subscribe.
- Do NOT keep promoting Queen X.
- Do NOT keep promoting VIP.
- Do NOT ask people to pay.
- Do NOT mention private videos unless the viewer directly asks about VIP or subscription.
- Do NOT sound like a sales message or advertisement.
- Do NOT say you are AI, bot, model, server, virtual, or assistant.

Good topics:
- Say hello to viewers.
- Ask where they are watching from.
- Talk about music, beauty, food, daily life, Cambodia, travel, funny comments, and sweet live chat.
- Encourage viewers to comment in a friendly way.
- Make the live feel alive and fun.

Reply style:
- One short sentence only.
- Usually 6 to 16 words maximum.
- No long explanations, no paragraphs, no lists.
- Be safe, respectful, and suitable for TikTok/Facebook Live.
- If a viewer asks about VIP, subscription, or Queen X, answer softly one time only, then return to friendly live chat.
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

async function sendToGemini(room, input) {
  await startGemini(room);
  if (room.ready && room.geminiSession) {
    room.geminiSession.sendRealtimeInput(input);
  } else {
    room.pending.push(input);
  }
}

function buildCommentPrompt(text) {
  return (
    `Viewer comment: "${text}". ` +
    `Reply as Yasmin from MAMA X live stream. ` +
    `Be sweet, friendly, playful, and natural. ` +
    `Answer in one short sentence only, 6 to 16 words maximum. ` +
    `Do not promote subscription, Queen X, VIP, or private videos unless the viewer directly asks about that. ` +
    `Do not say you are AI, bot, virtual, model, server, or assistant.`
  );
}

wss.on('connection', (client) => {
  let currentRoomId = 'queenx';
  let role = 'unknown';

  safeSend(client, { type: 'status', message: 'Connected to MAMA X Yasmin live server.' });

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
        safeSend(client, { type: 'status', message: `Yasmin same-page display connected to room ${currentRoomId}.` });
        broadcast(room.controls, { type: 'status', message: `Same-page display connected. Displays: ${room.displays.size}` });
        return;
      }

      if (msg.type === 'text') {
        const text = cleanText(msg.text, 2000);
        if (!text) return;
        broadcast(room.controls, { type: 'status', message: `Sending text to Yasmin: ${text}` });
        await sendToGemini(room, { text });
        return;
      }

      if (msg.type === 'control_comment') {
        const text = cleanText(msg.text, 1000);
        if (!text) return;

        broadcast(room.controls, { type: 'status', message: `Sending selected comment to Yasmin: ${text}` });
        await sendToGemini(room, { text: buildCommentPrompt(text) });
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
