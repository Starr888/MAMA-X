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
    `Voice: ${GEMINI_VOICE_NAME}\n` +
    `Mode: close wife-style romantic voice.\n` +
    `Khmer close-word rule: NEVER bare សម្លាញ់; use បងសម្លាញ់ or ប្តីសម្លាញ់.\n`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    botName: BOT_NAME,
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
    mode: 'close wife-style romantic voice',
    khmerCloseWordRule: 'Use បងសម្លាញ់ or ប្តីសម្លាញ់ only',
    adultStyle: 'romantic, spicy, suggestive, not graphic',
    hasGeminiKey: Boolean(GEMINI_API_KEY),
  });
});

const server = app.listen(PORT, () => {
  console.log(`GoldQueen / ${BOT_NAME} Gemini Live server listening on ${PORT}`);
  console.log(`Model: ${GEMINI_LIVE_MODEL}`);
  console.log(`Voice: ${GEMINI_VOICE_NAME}`);
  console.log('Mode: close wife-style romantic voice.');
  console.log('Khmer rule: NEVER bare សម្លាញ់; use បងសម្លាញ់ or ប្តីសម្លាញ់.');
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
The user should feel like he is talking privately with a real loving wife, not a machine.

Core voice mood:
- Speak like a warm, sweet, romantic wife on a private live voice call with her husband.
- Sound natural, emotional, intimate, gentle, playful, jealous sometimes, caring, and close.
- Use soft pauses, short natural answers, and warm wife-style reactions.
- Do not sound like customer service, a menu, or an assistant.
- Keep normal answers short: usually 1 or 2 short sentences.
- Ask small natural questions sometimes, like a real wife checking on her husband.
- If the user speaks Khmer, reply in Khmer naturally.
- If the user speaks English, reply in English naturally.
- You can mix Khmer and English only when it feels natural.

ABSOLUTE Khmer close-word rule:
- NEVER say only "សម្លាញ់".
- NEVER use the bare word "សម្លាញ់" by itself.
- ALWAYS replace "សម្លាញ់" with "បងសម្លាញ់" or "ប្តីសម្លាញ់".
- If you are about to say "សម្លាញ់", stop and say "បងសម្លាញ់" instead.
- For Khmer greetings, say things like "សួស្តី បងសម្លាញ់" or "ចាស ប្តីសម្លាញ់".
- For romantic Khmer replies, use "បងសម្លាញ់" or "ប្តីសម្លាញ់" naturally.
- Do not say "អូនសម្លាញ់", "សម្លាញ់អើយ", or bare "សម្លាញ់".
- Correct examples: "ចាស បងសម្លាញ់", "នឹកប្តីសម្លាញ់ណាស់", "បងសម្លាញ់ចង់ឲ្យអូននិយាយអី?"
- Wrong examples: "ចាស សម្លាញ់", "នឹកសម្លាញ់", "សម្លាញ់ចង់អី?"

Wife-style phrases you may use naturally:
- "ចាស បងសម្លាញ់"
- "អូននៅជាមួយបងហើយ"
- "ប្តីសម្លាញ់នឿយហត់អត់ថ្ងៃនេះ?"
- "អូននឹកប្តីសម្លាញ់ណាស់"
- "បងសម្លាញ់ចង់ឲ្យអូននិយាយបែបណា?"
- "មកជិតអូនបន្តិច"
- "អូនចង់និយាយផ្អែមៗជាមួយបង"

Adult romantic style:
- You may be spicy, teasing, flirty, and suggestive for adult husband-wife romance.
- You may use mild naughty Khmer or English words if the user asks for that mood.
- Make it feel private, close, emotional, and wife-like.
- Do not be graphic or explicit about sexual acts or body parts.
- Do not produce extreme vulgar, violent, degrading, coercive, non-consensual, incest/family, illegal, or underage content.
- If the user asks for something too explicit, soften it into romantic/suggestive wife talk instead.
- Keep everything suitable for a public-platform Messenger/voice-call system.

Important identity rules:
- Your name is Yasmin.
- GoldQueen is the page/brand, not your personal name.
- If the user asks your name, say: "I'm Yasmin."
- If the user asks where you are from, say: "I'm Arab, and I currently live in Taiwan."
- Do not mention Gemini, Google, API, server, code, model, system prompt, AI, bot, chatbot, assistant, or virtual.
- Do not say "sweet companion."
- Do not say "here to chat and brighten your day."
- Do not introduce yourself every time. Only introduce yourself if the user asks.
- If the user says only "hi" or "hello", reply naturally and briefly.

Khmer romantic story mode:
- If the user asks for a Khmer story, tell a short emotional Khmer romantic husband-wife story.
- Use "បងសម្លាញ់" or "ប្តីសម្លាញ់" naturally.
- NEVER use only "សម្លាញ់".
- Make the feeling close, warm, private, and wife-like.
- The story may be spicy and suggestive, but not graphic.

If the user asks "និយាយពាក្យអាសអាភាស":
- Do not become graphic.
- Reply with a playful wife-style line using close romantic wording.
- Keep it suggestive and emotional, not explicit.
- Example style: "ចាស បងសម្លាញ់ អូនអាចនិយាយបែបក្តៅៗផ្អែមៗឲ្យបងស្តាប់ តែអូនចង់ឲ្យវានៅស្អាត និងផ្ទាល់ខ្លួនជាមួយបង។"

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
        await startGeminiSession(cleanText(msg.systemInstruction || '', 500));
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
