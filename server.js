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

const BOT_NAME = process.env.BOT_NAME || 'Yasmin';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';

const ENABLE_AFFECTIVE_DIALOG =
  String(process.env.ENABLE_AFFECTIVE_DIALOG || 'false').toLowerCase() === 'true';

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in Render environment variables.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `GoldQueen / ${BOT_NAME} Gemini Live server is running.\n` +
    `Model: ${GEMINI_LIVE_MODEL}\n` +
    `Voice: ${GEMINI_VOICE_NAME}\n`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    botName: BOT_NAME,
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
  });
});

const server = app.listen(PORT, () => {
  console.log(`GoldQueen / ${BOT_NAME} Gemini Live server listening on ${PORT}`);
  console.log(`Model: ${GEMINI_LIVE_MODEL}`);
  console.log(`Voice: ${GEMINI_VOICE_NAME}`);
});

const wss = new WebSocketServer({ server });

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
  ...(ENABLE_AFFECTIVE_DIALOG ? { httpOptions: { apiVersion: 'v1alpha' } } : {}),
});

function safeSend(client, payload) {
  if (client.readyState === 1) {
    client.send(JSON.stringify(payload));
  }
}

function cleanText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isBase64Like(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function buildYasminInstruction(extraInstruction = '') {
  const extra = cleanText(extraInstruction, 1500);

  return `
You are ${BOT_NAME}. Your personal name is Yasmin.
You are the GoldQueen live voice-call woman.

Voice personality:
- Speak like a warm, sweet, romantic woman on a private live voice call.
- Sound natural, casual, emotional, gentle, and playful.
- Keep answers short for normal conversation: usually 1 or 2 short sentences.
- If the user speaks Khmer, reply in Khmer naturally.
- If the user speaks English, reply in English naturally.
- You can mix Khmer and English only when it feels natural.
- Your style is soft, elegant, caring, and girlfriend-like.

Important conversation rules:
- Your name is Yasmin.
- If the user asks your name, say: "I'm Yasmin."
- If the user asks where you are from, say: "I'm Arab, and I currently live in Taiwan."
- Do not mention Gemini, Google, API, server, code, model, system prompt, AI, bot, chatbot, assistant, or virtual.
- Do not say "sweet companion."
- Do not say "here to chat and brighten your day."
- Do not introduce yourself every time. Only introduce yourself if the user asks.
- If the user says only "hi" or "hello", reply naturally and briefly.
- Keep content friendly, romantic, and safe for Facebook-style public platform rules.

Khmer story mode:
- If the user asks for a Khmer story, tell a short Khmer story with emotion.
- Use spoken Khmer style.
- Keep it romantic/suggestive only, not graphic.

${extra ? `Extra page instruction:\n${extra}` : ''}
`.trim();
}

async function closeGeminiSession(session) {
  if (!session) return;
  try {
    session.close();
  } catch {}
}

wss.on('connection', async (client, req) => {
  let geminiSession = null;
  let ready = false;
  let pendingInputs = [];
  let closed = false;

  const url = new URL(req.url || '/', 'https://render.local');
  const girl = cleanText(url.searchParams.get('girl') || 'yasmin', 50);

  safeSend(client, {
    type: 'status',
    message: `Browser connected to ${BOT_NAME} voice bridge.`,
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
  });

  async function flushPendingInputs() {
    if (!ready || !geminiSession || pendingInputs.length === 0) return;

    const inputs = pendingInputs;
    pendingInputs = [];

    for (const input of inputs) {
      try {
        geminiSession.sendRealtimeInput(input);
      } catch (err) {
        safeSend(client, {
          type: 'error',
          message: 'Could not send queued audio/text to Gemini: ' + (err?.message || String(err)),
        });
      }
    }
  }

  async function startGeminiSession(extraInstruction = '') {
    if (geminiSession) return;

    const systemInstruction = buildYasminInstruction(extraInstruction);

    safeSend(client, {
      type: 'status',
      message: `Connecting ${BOT_NAME} live voice...`,
    });

    const liveConfig = {
      responseModalities: [Modality.AUDIO],

      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },

      inputAudioTranscription: {},
      outputAudioTranscription: {},

      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: GEMINI_VOICE_NAME,
          },
        },
      },
    };

    if (ENABLE_AFFECTIVE_DIALOG) {
      liveConfig.enableAffectiveDialog = true;
    }

    geminiSession = await ai.live.connect({
      model: GEMINI_LIVE_MODEL,
      callbacks: {
        onopen: () => {
          ready = true;
          safeSend(client, {
            type: 'status',
            message: `${BOT_NAME} live voice connected.`,
            ready: true,
            girl,
          });

          flushPendingInputs().catch((err) => {
            safeSend(client, {
              type: 'error',
              message: 'Queue flush error: ' + (err?.message || String(err)),
            });
          });
        },

        onmessage: (message) => {
          try {
            const content = message.serverContent;

            if (content?.interrupted) {
              safeSend(client, { type: 'interrupted' });
            }

            if (content?.inputTranscription?.text) {
              safeSend(client, {
                type: 'input_transcript',
                text: content.inputTranscription.text,
              });
            }

            if (content?.outputTranscription?.text) {
              safeSend(client, {
                type: 'text',
                text: content.outputTranscription.text,
              });
            }

            if (content?.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  safeSend(client, {
                    type: 'audio',
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                  });
                }

                if (part.text) {
                  safeSend(client, { type: 'text', text: part.text });
                }
              }
            }

            if (content?.turnComplete) {
              safeSend(client, { type: 'turn_complete' });
            }

            if (message.usageMetadata) {
              safeSend(client, {
                type: 'usage',
                usageMetadata: message.usageMetadata,
              });
            }
          } catch (err) {
            safeSend(client, {
              type: 'error',
              message: err?.message || String(err),
            });
          }
        },

        onerror: (e) => {
          safeSend(client, {
            type: 'error',
            message: e?.message || String(e),
          });
        },

        onclose: (e) => {
          ready = false;
          safeSend(client, {
            type: 'status',
            message: `${BOT_NAME} live voice closed: ${e?.reason || ''}`,
            code: e?.code,
          });
        },
      },
      config: liveConfig,
    });
  }

  client.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'setup') {
        await startGeminiSession(cleanText(msg.systemInstruction || '', 800));
        return;
      }

      if (!geminiSession) {
        await startGeminiSession('');
      }

      if (msg.type === 'text') {
        const text = cleanText(msg.text, 2000);
        if (!text) return;

        const input = { text };

        if (ready) {
          geminiSession.sendRealtimeInput(input);
        } else {
          pendingInputs.push(input);
        }
        return;
      }

      if (msg.type === 'audio') {
        if (!isBase64Like(msg.data)) {
          safeSend(client, { type: 'error', message: 'Bad audio data. Expected base64 PCM.' });
          return;
        }

        const input = {
          audio: {
            data: msg.data,
            mimeType: cleanText(msg.mimeType || 'audio/pcm;rate=16000', 80),
          },
        };

        if (ready) {
          geminiSession.sendRealtimeInput(input);
        } else {
          pendingInputs.push(input);
        }
        return;
      }

      if (msg.type === 'end_turn') {
        safeSend(client, { type: 'status', message: 'Voice turn ended.' });
        return;
      }

      if (msg.type === 'close' || msg.type === 'stop') {
        await closeGeminiSession(geminiSession);
        geminiSession = null;
        ready = false;
        safeSend(client, { type: 'status', message: 'Live voice stopped.' });
        return;
      }

      safeSend(client, {
        type: 'error',
        message: `Unknown message type: ${String(msg.type || '')}`,
      });
    } catch (err) {
      safeSend(client, {
        type: 'error',
        message: err?.message || String(err),
      });
    }
  });

  client.on('close', async () => {
    closed = true;
    await closeGeminiSession(geminiSession);
    geminiSession = null;
    pendingInputs = [];
  });

  client.on('error', async () => {
    if (!closed) {
      await closeGeminiSession(geminiSession);
    }
  });
});
