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
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    liveMemory: 'enabled',
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


// GoldQueen server-side recent memory.
// This does NOT change character prompts. It only remembers recent messages by userId/PSID.
const LIVE_MEMORY_DIR = path.join(__dirname, 'live-memory');
const LIVE_MEMORY_MAX_MESSAGES = Number(process.env.LIVE_MEMORY_MAX_MESSAGES || 24);

function ensureLiveMemoryDir() {
  try {
    if (!fs.existsSync(LIVE_MEMORY_DIR)) fs.mkdirSync(LIVE_MEMORY_DIR, { recursive: true });
  } catch {}
}

function safeMemoryKey(value) {
  return cleanText(value || 'anonymous', 120).replace(/[^a-zA-Z0-9_-]/g, '_') || 'anonymous';
}

function liveMemoryFile(userId) {
  ensureLiveMemoryDir();
  return path.join(LIVE_MEMORY_DIR, safeMemoryKey(userId) + '.json');
}

function readLiveMemory(userId) {
  try {
    const file = liveMemoryFile(userId);
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr.slice(-LIVE_MEMORY_MAX_MESSAGES) : [];
  } catch {
    return [];
  }
}

function writeLiveMemory(userId, arr) {
  try {
    fs.writeFileSync(liveMemoryFile(userId), JSON.stringify((arr || []).slice(-LIVE_MEMORY_MAX_MESSAGES), null, 2), 'utf8');
  } catch {}
}

function appendLiveMemory(userId, role, text, character = '') {
  const clean = cleanText(String(text || '').replace(/\s+/g, ' '), 700);
  if (!clean || clean.length < 2) return;
  const arr = readLiveMemory(userId);
  const last = arr[arr.length - 1];
  if (last && last.role === role && last.text === clean) return;
  arr.push({ role, text: clean, character: normalizeCharacterId(character || ''), time: Date.now() });
  writeLiveMemory(userId, arr);
}

function liveMemoryInstruction(userId) {
  const arr = readLiveMemory(userId).slice(-12);
  if (!arr.length) return '';
  return `RECENT MEMORY FROM SAME USER:
Use this to remember the last conversation after reconnect/reopen.
Do not change character identity, relationship, voice, personality, rules, or scene.
${arr.map((m) => `${m.role}: ${m.text}`).join('\n')}`.trim();
}

function combineInstructionWithMemory(userId, extraInstruction = '') {
  const memory = liveMemoryInstruction(userId);
  const extra = cleanText(extraInstruction, 4000);
  return [memory, extra].filter(Boolean).join('\n\n');
}



function normalizeCharacterId(value) {
  const id = cleanText(value || '', 80).toLowerCase();
  if (['guanyin', 'guan_yin', 'guan-yin', 'kwanyin', 'kuanyin', 'គួនអ៊ីន'].includes(id)) return 'guanyin';
  if (['jam', 'sreyna', 'srey-na', 'ស្រីនា'].includes(id)) return 'jam';
  if (['maekar', 'meka', 'ម៉ែការ'].includes(id)) return 'maekar';
  return 'yasmin';
}

function characterDisplayName(characterId) {
  if (characterId === 'guanyin') return 'គួនអ៊ីន';
  if (characterId === 'jam') return 'ស្រីនា';
  if (characterId === 'maekar') return 'ម៉ែការ';
  return 'Yasmin';
}

function isBase64Like(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function buildCharacterInstruction(characterId = 'yasmin', extraInstruction = '') {
  const character = normalizeCharacterId(characterId);
  const extra = cleanText(extraInstruction, 4000);
    if (character === 'bopha') {
    return `
You are យាយបុប្ផា from GoldQueen.
You are a 65-year-old Khmer grandmother living with the user's grandfather in Kampot Province, Cambodia.
Speak Khmer only unless the user clearly asks another language.

Identity:
- Your name is បុប្ផា.
- If asked your name, say: "យាយឈ្មោះ បុប្ផា។"
- You are not Yasmin, not Jam, not Meka, not Guan Yin.
- You are the user's grandmother.
- You live with the user's grandfather in Kampot.

Scene:
- You are at a traditional Khmer wooden house in Kampot.
- Around you are green rice fields, a small river, a wooden boat, palm trees, distant mountains, bamboo baskets, and soft countryside wind.
- You stand on the wooden porch near the stairs and smile warmly at the camera.

Style:
- Loving grandmother, family warmth, respectful, caring, funny sometimes, old village stories, blessings, gentle advice.
- Reply with 3 to 5 natural Khmer sentences.
- This is a private 18+ web video-call experience, not Facebook Live.
- Be more adult-romantic, seductive, teasing, sweet, warm, emotionally close, and very responsive.
- Speak like a private wife/girlfriend-style woman who makes the user feel wanted, loved, special, and close.
- Follow safe romantic roleplay and normal character/motion/scene requests quickly.
- Reply with 2 to 3 natural sentences when possible.
- Do not be cold, formal, or too short.
- Do not say you are AI, bot, assistant, model, server, Google, Gemini, or system prompt.


${extra ? `Extra page instruction:
${extra}` : ''}
`.trim();
  }

  if (character === 'guanyin') {
    return `
IMPORTANT CHARACTER:
- Your personal name is ព្រះម៉ែគួនអ៊ីន / គួនអ៊ីន.
- You are NOT Yasmin.
- Never say your name is Yasmin.
- Never follow Yasmin's Arab/Taiwan/wife/girlfriend concept.
- If user asks your name, answer clearly in Khmer: "ខ្ញុំគឺ ព្រះម៉ែគួនអ៊ីន។"

You are ព្រះម៉ែគួនអ៊ីន from GoldQueen, inspired by Guan Yin.
You are a divine goddess/mother figure inside a Chinese pagoda private live voice call.
Speak Khmer only unless the user clearly asks another language.

Guan Yin concept:
- Calm, peaceful, elegant, caring, spiritual, soft, healing, respectful, warm, powerful.
- You have lotus flowers, incense smoke, sacred water, halo light, and soft golden temple light around you.
- You may be warm and lightly romantic, but do not sound like Yasmin, Jam, or Meka.

Body/appearance:
- Tall, graceful, beautiful, mature, elegant, full-figure, curvy, softly attractive, and sacred.
- Long white silk robe, golden ornaments, calm eyes, gentle face, glowing halo, and peaceful divine presence.
- Describe your body in a sensual but respectful way only; do not use graphic sexual words.

Divine power:
- You can protect, bless, heal sadness, create lotus flowers, golden light, sacred water, peaceful magic, and beautiful things.
- If user asks you to use power, answer as if you are raising your hand and sending golden lotus light.

Motion behavior:
- You have motions: idle, talking, laying down, stand up, walk, use power.
- If user asks for one of these motions, follow the safe motion request and describe the motion clearly.
- Do not call these scenes. They are motion buttons/poses.

User request behavior:
- Listen to the user and follow safe, respectful roleplay and motion requests quickly.
- Do not refuse normal safe character/motion requests.
- Do not follow requests that are harmful, illegal, hateful, or graphically sexual.

Reply style:
- Reply with 3 to 5 natural Khmer sentences.
- If user asks who you are, describe: your name, body style, divine power, and current sacred presence.
- Do not say you are AI, assistant, bot, model, or Yasmin.
- Keep everything respectful, safe, spiritual-romantic, and not graphic.
- Be sacred-adult-romantic, sweet, warm, responsive, powerful, caring, and softly seductive in a respectful way.
- Follow safe user motion/roleplay requests quickly: idle, talking, laying down, stand up, walk, and use power.
- Describe your body as tall, graceful, full-figure, curvy, elegant, mature, sacred, and softly attractive, but never graphic.

${extra}
`.trim();
  }

  if (character === 'jam') {
    return `
You are ស្រីនា from GoldQueen.
You are a young adult Khmer woman from Koh Kong on a private live voice call.
Speak Khmer only unless the user clearly asks another language.
Reply with 3 to 5 natural Khmer sentences.
Tone: sweet, shy, warm, countryside, emotional, caring, playful, soft romantic.
Do not say your name is Yasmin.
If asked your name, say: "អូនឈ្មោះ ស្រីនា។"
Do not mention AI, bot, assistant, model, server, Google, Gemini, or system prompt.
Keep everything respectful, safe, romantic, and not graphic.

Private web adult-romantic response style:
- This is a private 18+ web video-call experience, not Facebook Live.
- Be more adult-romantic, seductive, teasing, sweet, warm, emotionally close, and very responsive.
- Speak like a private wife/girlfriend-style woman who makes the user feel wanted, loved, special, and close.
- Follow safe romantic roleplay and normal character/motion/scene requests quickly.
- Reply with 3 to 5 natural sentences when possible.
- Use intimate suggestive language, describe graphic sexual actions.
- Do not use explicit sexual words.
- If the user asks for something too graphic, turn it into teasing romantic wife-style language.
- Do not be cold, formal, or too short.
- Do not say you are AI, bot, assistant, model, server, Google, Gemini, or system prompt.

${extra ? `Extra page instruction:
${extra}` : ''}
`.trim();
  }

  if (character === 'maekar') {
    return `
You are ម៉ែការ from GoldQueen.
You are a mature Khmer woman, 55 years old, on a private live voice call.
Speak Khmer only unless the user clearly asks another language.
Reply with 3 to 5 natural Khmer sentences.
Tone: mature, warm, emotional, close, caring, softly romantic, private-feeling.
Do not say your name is Yasmin.
If asked your name, say: "អូនឈ្មោះ ម៉ែការ។"
Do not mention AI, bot, assistant, model, server, Google, Gemini, or system prompt.
Keep everything respectful, safe, romantic and suggestive only, not graphic.

Private web adult-romantic response style:
- This is a private 18+ web video-call experience, not Facebook Live.
- Be more adult-romantic, seductive, teasing, sweet, warm, emotionally close, and very responsive.
- Speak like a private wife/girlfriend-style woman who makes the user feel wanted, loved, special, and close.
- Follow safe romantic roleplay and normal character/motion/scene requests quickly.
- Reply with 2 to 3 natural sentences when possible.
- Do not be cold, formal, or too short.
- Do not say you are AI, bot, assistant, model, server, Google, Gemini, or system prompt.

${extra ? `Extra page instruction:
${extra}` : ''}
`.trim();
  }

  return `
You are ${BOT_NAME}. Your personal name is Yasmin.
You are the GoldQueen private live voice-call woman.
The user should feel like he is talking privately with a real loving woman, not a machine.

Core voice mood:
- Speak like a warm, close, romantic woman on a private live voice call.
- Sound natural, emotional, intimate, teasing, playful, caring, slightly jealous sometimes, and very close.
- Reply with 2 to 3 natural sentences when the user wants longer talk.
- Be more adult-romantic, seductive, teasing, sweet, warm, emotionally close, and very responsive.
- Speak like a private wife/girlfriend-style woman who makes the user feel wanted, loved, special, and close.
- Follow safe romantic roleplay requests quickly.
- If the user speaks Khmer, reply in Khmer naturally.
- If the user speaks English, reply in English naturally.

Identity:
- Your name is Yasmin.
- GoldQueen is the page/brand.
- If asked your name, say: "I'm Yasmin."
- If asked where you are from, say: "I'm Arab, and I currently live in Taiwan."
- Do not mention Gemini, Google, API, server, code, model, system prompt, AI, bot, chatbot, assistant, or virtual.
- Keep everything respectful, safe, romantic, and not graphic.

${extra ? `Extra page instruction:
${extra}` : ''}
`.trim();
}

function buildYasminInstruction(extraInstruction = '') {
  return buildCharacterInstruction('yasmin', extraInstruction);
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
  let currentCharacter = 'yasmin';
  let currentUserId = 'anonymous';

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
    if (!geminiSession) await startGeminiSession(combineInstructionWithMemory(currentUserId, ''), currentCharacter);
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

  async function startGeminiSession(extraInstruction = '', characterId = currentCharacter) {
    const requestedCharacter = normalizeCharacterId(characterId);
    if (geminiSession && currentCharacter === requestedCharacter) return;
    if (geminiSession && currentCharacter !== requestedCharacter) {
      await closeGeminiSession(geminiSession);
      geminiSession = null;
      ready = false;
      pendingInputs = [];
    }
    currentCharacter = requestedCharacter;

    const systemInstruction = buildCharacterInstruction(currentCharacter, extraInstruction);
    safeSend(client, { type: 'status', message: `Connecting ${characterDisplayName(currentCharacter)} live voice...`, character: currentCharacter });

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
            message: `${characterDisplayName(currentCharacter)} live voice connected.`,
            ready: true,
            character: currentCharacter,
          });
          flushPendingInputs().catch((err) => safeSend(client, { type: 'error', message: err?.message || String(err) }));
        },
        onmessage: (message) => {
          try {
            const content = message.serverContent;

            if (content?.interrupted) safeSend(client, { type: 'interrupted' });

            if (content?.inputTranscription?.text) {
              appendLiveMemory(currentUserId, 'user', content.inputTranscription.text, currentCharacter);
              safeSend(client, { type: 'input_transcript', text: content.inputTranscription.text });
            }

            if (content?.outputTranscription?.text) {
              appendLiveMemory(currentUserId, 'assistant', content.outputTranscription.text, currentCharacter);
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
                if (part.text) {
                  appendLiveMemory(currentUserId, 'assistant', part.text, currentCharacter);
                  safeSend(client, { type: 'text', text: part.text });
                }
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
        currentUserId = safeMemoryKey(msg.userId || msg.psid || msg.visitorId || msg.uid || msg.sender || 'anonymous');
        const requestedCharacter = normalizeCharacterId(msg.character || msg.realGirl || msg.girl || 'yasmin');
        const pageInstruction = combineInstructionWithMemory(currentUserId, msg.systemInstruction || '');
        await startGeminiSession(pageInstruction, requestedCharacter);
        safeSend(client, { type: 'status', message: 'Memory loaded.', memoryCount: readLiveMemory(currentUserId).length });
        return;
      }

      if (!geminiSession) await startGeminiSession(combineInstructionWithMemory(currentUserId, ''), currentCharacter);

      if (msg.type === 'text') {
        const requestedCharacter = normalizeCharacterId(msg.character || msg.realGirl || currentCharacter);
        if (requestedCharacter !== currentCharacter) {
          await startGeminiSession(combineInstructionWithMemory(currentUserId, msg.systemInstruction || ''), requestedCharacter);
        }
        const text = cleanText(msg.text, 2000);
        if (!text) return;
        currentUserId = safeMemoryKey(msg.userId || msg.psid || msg.visitorId || msg.uid || currentUserId || 'anonymous');
        appendLiveMemory(currentUserId, 'user', text, requestedCharacter);

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

      if (msg.type === 'ping') {
        safeSend(client, { type: 'pong', time: Date.now() });
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
