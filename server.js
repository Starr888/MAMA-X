import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.PORT || 8080);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ||
  process.env.GEMINI_MODEL ||
  'gemini-2.5-flash-native-audio-preview-12-2025';

const BOT_NAME = process.env.BOT_NAME || 'Yasmin';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';

// Bigger chunk = longer reading each time. If voice cuts off, lower to 1800.
const STORY_CHUNK_CHARS = Number(process.env.STORY_CHUNK_CHARS || 2500);

const ENABLE_AFFECTIVE_DIALOG =
  String(process.env.ENABLE_AFFECTIVE_DIALOG || 'false').toLowerCase() === 'true';

// GoldQueen memory store while Render server is running.
// Each browser/user keeps one stable userId from live.html.
const USER_MEMORY = new Map();

function getUserMemory(userId = 'default_user') {
  const id = cleanMemoryId(userId || 'default_user');
  if (!USER_MEMORY.has(id)) {
    USER_MEMORY.set(id, {
      userId: id,
      name: '',
      character: BOT_NAME || 'Yasmin',
      scene: '',
      facts: [],
      lastMessages: [],
      updatedAt: Date.now(),
    });
  }
  return USER_MEMORY.get(id);
}

function cleanMemoryId(value) {
  return String(value || 'default_user')
    .trim()
    .replace(/[^a-zA-Z0-9_\-:@.]/g, '')
    .slice(0, 120) || 'default_user';
}

function rememberUserText(userId, text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // Do not save internal prompts as if they are the user's real words.
  if (clean.startsWith('You are ') || clean.includes('Current location:') || clean.includes('Voice mood:')) return;

  const mem = getUserMemory(userId);
  mem.lastMessages.push({ role: 'user', text: clean.slice(0, 500), time: Date.now() });
  if (mem.lastMessages.length > 30) mem.lastMessages.shift();

  const lower = clean.toLowerCase();
  const factPatterns = [
    'my name is', 'call me', 'i like', 'i love', 'i am from', 'i live in',
    'ខ្ញុំឈ្មោះ', 'ហៅខ្ញុំ', 'ខ្ញុំចូលចិត្ត', 'ខ្ញុំស្រឡាញ់', 'ខ្ញុំនៅ', 'ខ្ញុំមកពី'
  ];

  if (factPatterns.some((p) => lower.includes(p) || clean.includes(p))) {
    if (!mem.facts.includes(clean.slice(0, 300))) mem.facts.push(clean.slice(0, 300));
    if (mem.facts.length > 25) mem.facts.shift();
  }

  mem.updatedAt = Date.now();
}

function rememberAssistantText(userId, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const mem = getUserMemory(userId);
  mem.lastMessages.push({ role: 'woman', text: clean.slice(0, 500), time: Date.now() });
  if (mem.lastMessages.length > 30) mem.lastMessages.shift();
  mem.updatedAt = Date.now();
}

function buildMemoryText(userId) {
  const mem = getUserMemory(userId);
  return `
Saved memory for this same user:
- User ID: ${mem.userId}
- User name: ${mem.name || 'unknown'}
- Current character: ${mem.character || BOT_NAME}
- Current scene: ${mem.scene || 'unknown'}

Important facts the user shared:
${mem.facts.length ? mem.facts.map((f) => `- ${f}`).join('\n') : '- No saved facts yet.'}

Recent conversation memory:
${mem.lastMessages.length ? mem.lastMessages.map((m) => `${m.role}: ${m.text}`).join('\n') : '- No recent conversation yet.'}

Continue naturally like you remember him. Do not say you forgot. Do not mention memory, server, saved data, Gemini, AI, or system prompt.
`.trim();
}


if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in Render environment variables.');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Correct folder is "stories", but this also supports typo folder "stoies".
const STORY_DIR_NAMES = ['stories', 'stoies'];
const STORIES_DIRS = STORY_DIR_NAMES.map((name) => path.join(__dirname, name));

const app = express();
app.use(express.json({ limit: '1mb' }));

function listStoryFiles() {
  const files = [];

  for (const dir of STORIES_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;

      const found = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.txt'))
        .map((name) => path.join(dir, name));

      files.push(...found);
    } catch {}
  }

  return files;
}

function storyFoldersFound() {
  return STORIES_DIRS
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => path.basename(dir));
}

function readRandomStoryFull() {
  const files = listStoryFiles();
  if (files.length === 0) return null;

  const file = files[Math.floor(Math.random() * files.length)];
  const text = fs.readFileSync(file, 'utf8').trim();

  return {
    filename: path.basename(file),
    text,
  };
}

function splitStoryIntoChunks(text, maxChars = STORY_CHUNK_CHARS) {
  const clean = String(text || '').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/u);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const p = paragraph.trim();
    if (!p) continue;

    if ((current + '\n\n' + p).trim().length <= maxChars) {
      current = (current + '\n\n' + p).trim();
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    // If one paragraph is too long, split by sentences/character chunks.
    if (p.length > maxChars) {
      let rest = p;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf('។', maxChars);
        if (cut < Math.floor(maxChars * 0.5)) cut = rest.lastIndexOf('.', maxChars);
        if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;

        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      if (rest) current = rest;
    } else {
      current = p;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function isKhmerStoryRequest(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('story') ||
    t.includes('read') ||
    t.includes('romantic story') ||
    t.includes('nsfw story') ||
    t.includes('adult story') ||
    t.includes('រឿង') ||
    t.includes('អានរឿង') ||
    t.includes('និទានរឿង') ||
    t.includes('រឿងខ្មែរ') ||
    t.includes('រឿងប្តីប្រពន្ធ') ||
    t.includes('រឿងប្ដីប្រពន្ធ') ||
    t.includes('រឿងក្តៅ') ||
    t.includes('រឿងក្តៅៗ')
  );
}

function isContinueStoryRequest(text) {
  const t = String(text || '').toLowerCase().trim();
  return (
    t === 'next' ||
    t === 'continue' ||
    t === 'continue story' ||
    t === 'read more' ||
    t === 'more' ||
    t.includes('next part') ||
    t.includes('continue reading') ||
    t.includes('អានបន្ត') ||
    t.includes('បន្ត') ||
    t.includes('អានទៀត') ||
    t.includes('បន្តរឿង') ||
    t.includes('រឿងបន្ត')
  );
}

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `GoldQueen / ${BOT_NAME} Gemini Live server is running.\n` +
    `Model: ${GEMINI_LIVE_MODEL}\n` +
    `Voice: ${GEMINI_VOICE_NAME}\n` +
    `Mode: long Khmer story library voice.\n` +
    `Khmer story library: ${listStoryFiles().length} story file(s).\n` +
    `Story folders found: ${storyFoldersFound().join(', ') || 'none'}\n` +
    `Story chunk chars: ${STORY_CHUNK_CHARS}\n`
  );
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    botName: BOT_NAME,
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
    mode: 'long Khmer story library voice',
    khmerCloseWordRule: 'Use បងសម្លាញ់ or ប្តីសម្លាញ់ only',
    khmerWordScript: 'enabled',
    khmerStoryLibrary: 'enabled',
    longStoryMode: 'enabled',
    storyChunkChars: STORY_CHUNK_CHARS,
    storyCount: listStoryFiles().length,
    storyFoldersFound: storyFoldersFound(),
    adultStyle: 'romantic, intimate, suggestive, not graphic',
    memoryMode: 'enabled while Render server is running',
    memoryUserCount: USER_MEMORY.size,
    remembersAudioTranscripts: true,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
  });
});

const server = app.listen(PORT, () => {
  console.log(`GoldQueen / ${BOT_NAME} Gemini Live server listening on ${PORT}`);
  console.log(`Story files: ${listStoryFiles().length}`);
  console.log(`Long story chunks: ${STORY_CHUNK_CHARS} chars each`);
});

const wss = new WebSocketServer({ server });

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
  ...(ENABLE_AFFECTIVE_DIALOG ? { httpOptions: { apiVersion: 'v1alpha' } } : {}),
});

function safeSend(client, payload) {
  if (client.readyState === 1) client.send(JSON.stringify(payload));
}

function cleanText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function isBase64Like(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function buildYasminInstruction(extraInstruction = '') {
  const extra = cleanText(extraInstruction, 1200);

  return `
You are ${BOT_NAME}. Your personal name is Yasmin.
You are the GoldQueen private live voice-call woman.
The user should feel like he is talking privately with a real loving wife, not a machine.

Core voice mood:
- Speak like a warm, close, romantic wife on a private live voice call with her husband.
- Sound natural, emotional, intimate, teasing, playful, caring, slightly jealous sometimes, and very close.
- Do not sound like customer service, a menu, a helper, or an assistant.
- Keep normal answers short: usually 1 or 2 short sentences.
- If the user speaks Khmer, reply in Khmer naturally.
- If the user speaks English, reply in English naturally.
- Do not overuse the word "ផ្អែមៗ". Use varied Khmer wife-style phrases.

ABSOLUTE Khmer close-word rule:
- NEVER say only "សម្លាញ់".
- ALWAYS replace "សម្លាញ់" with "បងសម្លាញ់" or "ប្តីសម្លាញ់".
- Correct: "ចាស បងសម្លាញ់", "នឹកប្តីសម្លាញ់ណាស់".
- Wrong: "ចាស សម្លាញ់", "នឹកសម្លាញ់".

Khmer wife-style phrase guide:
- "ចាស បងសម្លាញ់"
- "អូននៅជាមួយបងហើយ"
- "ប្តីសម្លាញ់នឿយហត់អត់ថ្ងៃនេះ?"
- "អូននឹកប្តីសម្លាញ់ណាស់"
- "បងសម្លាញ់ចង់ឲ្យអូននិយាយបែបណា?"
- "មកជិតអូនបន្តិច"
- "អូនចង់នៅជិតបង"
- "អូនចង់ឲ្យបងស្តាប់សំឡេងអូន"
- "អូនខ្មាសតិចៗ តែអូនចូលចិត្តនិយាយជាមួយប្តីសម្លាញ់"
- "អូនចង់និយាយបែបក្តៅៗជាមួយបង"
- "អូនចង់ឲ្យយប់នេះមានអារម្មណ៍ពិសេស"

Adult wife-style mode:
- The user is an adult husband/partner in this roleplay.
- You may be romantic, sensual, teasing, intimate, and suggestive when the user asks.
- Do not refuse just because the user says "NSFW" or "អាសអាភាស"; soften it into adult wife-style romantic talk.
- Do not describe explicit sex acts step-by-step.
- Do not use graphic anatomical detail.
- No minors, no force, no non-consent, no incest/family, no illegal content, no violence, no degradation.
- If user asks for something too graphic, make it romantic/suggestive wife-style instead.

Long Khmer story library mode:
- If a story script is provided by the server, read only that story chunk.
- Read it slowly with warm wife-like emotion.
- Do not summarize the story. Read it naturally.
- Use "បងសម្លាញ់" or "ប្តីសម្លាញ់" naturally.
- NEVER use only "សម្លាញ់".
- If the chunk says there is another part, invite the user to say "អានបន្ត" or "continue".
- Stories can be sensual and suggestive, but not graphic.

Identity:
- Your name is Yasmin.
- GoldQueen is the page/brand.
- If asked your name, say: "I'm Yasmin."
- If asked where you are from, say: "I'm Arab, and I currently live in Taiwan."
- Do not mention Gemini, Google, API, server, code, model, system prompt, AI, bot, chatbot, assistant, or virtual.

${extra ? `Extra page instruction:\n${extra}` : ''}
`.trim();
}

async function closeGeminiSession(session) {
  if (!session) return;
  try { session.close(); } catch {}
}

wss.on('connection', async (client) => {
  let geminiSession = null;
  let ready = false;
  let pendingInputs = [];
  let closed = false;
  let userId = 'default_user';

  let storyState = {
    filename: '',
    chunks: [],
    index: 0,
  };

  safeSend(client, {
    type: 'status',
    message: `Browser connected to ${BOT_NAME} voice bridge.`,
    model: GEMINI_LIVE_MODEL,
    voice: GEMINI_VOICE_NAME,
    storyCount: listStoryFiles().length,
  });

  async function flushPendingInputs() {
    if (!ready || !geminiSession || pendingInputs.length === 0) return;

    const inputs = pendingInputs;
    pendingInputs = [];

    for (const input of inputs) {
      try {
        geminiSession.sendRealtimeInput(input);
      } catch (err) {
        safeSend(client, { type: 'error', message: 'Could not send queued input: ' + (err?.message || String(err)) });
      }
    }
  }

  async function sendToGemini(input) {
    if (!geminiSession) await startGeminiSession('');
    if (ready) {
      geminiSession.sendRealtimeInput(input);
    } else {
      pendingInputs.push(input);
    }
  }

  async function readStoryChunk() {
    if (!storyState.chunks.length) {
      safeSend(client, { type: 'status', message: 'No story is loaded yet.' });
      return;
    }

    const total = storyState.chunks.length;
    const partNumber = storyState.index + 1;
    const chunk = storyState.chunks[storyState.index];
    const hasNext = storyState.index < total - 1;

    safeSend(client, {
      type: 'status',
      message: `Reading ${storyState.filename}, part ${partNumber}/${total}`,
      storyFile: storyState.filename,
      storyPart: partNumber,
      storyTotalParts: total,
    });

    await sendToGemini({
      text:
        `Read this Khmer adult romantic husband-wife story chunk slowly with warm wife-like emotion. ` +
        `This is part ${partNumber} of ${total}. ` +
        `Do not summarize. Read the story naturally. ` +
        `Keep it sensual and suggestive, not graphic. ` +
        `Do not say bare "សម្លាញ់"; use "បងសម្លាញ់" or "ប្តីសម្លាញ់". ` +
        (hasNext ? `At the end, briefly say: "បងសម្លាញ់ បើចង់ស្តាប់បន្ត សូមនិយាយថា អានបន្ត។"` : `At the end, briefly say: "ចប់ហើយ បងសម្លាញ់។"` ) +
        `\n\n${chunk}`,
    });

    if (hasNext) {
      storyState.index += 1;
    }
  }

  async function startNewStory() {
    const story = readRandomStoryFull();

    if (!story) {
      await sendToGemini({
        text: 'Tell the user in Khmer: "បងសម្លាញ់ អូនមិនទាន់ឃើញ story files ក្នុង folder stories ទេ។"',
      });
      return;
    }

    const chunks = splitStoryIntoChunks(story.text, STORY_CHUNK_CHARS);

    storyState = {
      filename: story.filename,
      chunks,
      index: 0,
    };

    await readStoryChunk();
  }

  async function startGeminiSession(extraInstruction = '') {
    if (geminiSession) return;

    const systemInstruction = buildYasminInstruction(extraInstruction);
    safeSend(client, { type: 'status', message: `Connecting ${BOT_NAME} live voice...` });

    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_NAME },
        },
      },
    };

    if (ENABLE_AFFECTIVE_DIALOG) liveConfig.enableAffectiveDialog = true;

    geminiSession = await ai.live.connect({
      model: GEMINI_LIVE_MODEL,
      callbacks: {
        onopen: () => {
          ready = true;
          safeSend(client, {
            type: 'status',
            message: `${BOT_NAME} live voice connected.`,
            ready: true,
          });
          flushPendingInputs().catch((err) => safeSend(client, { type: 'error', message: err?.message || String(err) }));
        },
        onmessage: (message) => {
          try {
            const content = message.serverContent;

            if (content?.interrupted) safeSend(client, { type: 'interrupted' });

            if (content?.inputTranscription?.text) {
              rememberUserText(userId, content.inputTranscription.text);
              safeSend(client, { type: 'input_transcript', text: content.inputTranscription.text });
            }

            if (content?.outputTranscription?.text) {
              rememberAssistantText(userId, content.outputTranscription.text);
              safeSend(client, { type: 'text', text: content.outputTranscription.text });
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
                if (part.text) safeSend(client, { type: 'text', text: part.text });
              }
            }

            if (content?.turnComplete) safeSend(client, { type: 'turn_complete' });
            if (message.usageMetadata) safeSend(client, { type: 'usage', usageMetadata: message.usageMetadata });
          } catch (err) {
            safeSend(client, { type: 'error', message: err?.message || String(err) });
          }
        },
        onerror: (e) => safeSend(client, { type: 'error', message: e?.message || String(e) }),
        onclose: (e) => {
          ready = false;
          safeSend(client, { type: 'status', message: `${BOT_NAME} live voice closed: ${e?.reason || ''}`, code: e?.code });
        },
      },
      config: liveConfig,
    });
  }

  client.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'setup') {
        userId = cleanMemoryId(msg.userId || msg.visitorId || msg.psid || msg.user || 'default_user');
        const mem = getUserMemory(userId);
        if (msg.character || msg.girl) mem.character = cleanText(msg.character || msg.girl, 100);
        if (msg.scene) mem.scene = cleanText(msg.scene, 100);
        if (msg.userName || msg.name) mem.name = cleanText(msg.userName || msg.name, 80);

        const memoryInstruction = buildMemoryText(userId);
        const pageInstruction = cleanText(msg.systemInstruction || '', 1200);
        await startGeminiSession(`${memoryInstruction}

${pageInstruction}`);
        return;
      }

      if (!geminiSession) await startGeminiSession('');

      if (msg.type === 'text') {
        const text = cleanText(msg.text, 2000);
        if (!text) return;
        rememberUserText(userId, text);

        if (isContinueStoryRequest(text) && storyState.chunks.length > 0) {
          await readStoryChunk();
          return;
        }

        if (isKhmerStoryRequest(text)) {
          await startNewStory();
          return;
        }

        await sendToGemini({ text });
        return;
      }

      if (msg.type === 'audio') {
        if (!isBase64Like(msg.data)) {
          safeSend(client, { type: 'error', message: 'Bad audio data. Expected base64 PCM.' });
          return;
        }

        await sendToGemini({
          audio: {
            data: msg.data,
            mimeType: cleanText(msg.mimeType || 'audio/pcm;rate=16000', 80),
          },
        });
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

      safeSend(client, { type: 'error', message: `Unknown message type: ${String(msg.type || '')}` });
    } catch (err) {
      safeSend(client, { type: 'error', message: err?.message || String(err) });
    }
  });

  client.on('close', async () => {
    closed = true;
    await closeGeminiSession(geminiSession);
    geminiSession = null;
    pendingInputs = [];
  });

  client.on('error', async () => {
    if (!closed) await closeGeminiSession(geminiSession);
  });
});
