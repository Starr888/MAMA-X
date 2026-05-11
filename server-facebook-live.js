import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';
const BOT_NAME = process.env.BOT_NAME || 'ព្រះម៉ែគួនអ៊ីន';
const CHARACTER = process.env.CHARACTER || 'guanyin';

const FB_GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const FACEBOOK_PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
const FACEBOOK_LIVE_VIDEO_ID = process.env.FACEBOOK_LIVE_VIDEO_ID || '';
const COMMENT_POLL_SECONDS = Number(process.env.COMMENT_POLL_SECONDS || 8);
const MIN_REPLY_SECONDS = Number(process.env.MIN_REPLY_SECONDS || 22);
const LIVE_TOPIC = process.env.LIVE_TOPIC || 'blessing, peace, love, emotional healing, life advice, spiritual comfort, good luck, protection, relationship advice';
const LIVE_TOPIC_KEYWORDS = (process.env.LIVE_TOPIC_KEYWORDS || 'bless,blessing,pray,prayer,peace,love,life,advice,help,family,good luck,protection,relationship,heart,sad,stress,ខ្មែរ,ជូនពរ,សំណាង,ស្នេហា,គ្រួសារ,សុខសាន្ត,ជួយ,អធិស្ឋាន,ព្រះម៉ែ,គួនអ៊ីន').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in Render environment variables.');
  process.exit(1);
}

const app = express();
app.use(express.json({limit:'1mb'}));

const server = app.listen(PORT, () => {
  console.log(`GoldQueen Facebook Live Avatar server listening on ${PORT}`);
  console.log(`Bot: ${BOT_NAME}, Character: ${CHARACTER}, Voice: ${GEMINI_VOICE_NAME}`);
});

const wss = new WebSocketServer({ server, path: '/live-stream' });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
let clients = new Set();
let geminiSession = null;
let ready = false;
let pendingTexts = [];
let seenCommentIds = new Set();
let commentQueue = [];
let lastReplyAt = 0;
let isSpeaking = false;
let pollTimer = null;
let pumpTimer = null;
let commentCountSeen = 0;
let commentCountAnswered = 0;

function broadcast(payload){
  const data = JSON.stringify(payload);
  for(const c of clients){
    if(c.readyState === 1) c.send(data);
  }
}
function cleanText(value, max=1200){ return typeof value === 'string' ? value.trim().slice(0,max) : ''; }
function now(){ return Date.now(); }
function onlyEmojiOrTiny(text){
  const t = String(text || '').trim();
  if(t.length < 3) return true;
  const withoutEmoji = t.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!?.。、។,]/gu, '');
  return withoutEmoji.length < 2;
}
function isSpam(text){
  const t = String(text||'').toLowerCase().trim();
  if(!t) return true;
  if(onlyEmojiOrTiny(t)) return true;
  if(t.length > 240) return true;
  if(/https?:\/\//i.test(t) || /www\./i.test(t)) return true;
  if(/(.)\1{8,}/.test(t)) return true;
  const bad = ['fuck','shit','porn','xxx','nude','sex video','telegram','whatsapp'];
  return bad.some(w => t.includes(w));
}
function scoreComment(text){
  const t = String(text||'').toLowerCase();
  if(isSpam(t)) return -999;
  let score = 0;
  if(/[?？]/.test(t) || t.includes('can you') || t.includes('please') || t.includes('help') || t.includes('ជួយ') || t.includes('សូម')) score += 4;
  for(const kw of LIVE_TOPIC_KEYWORDS){ if(kw && t.includes(kw)) score += 3; }
  if(t.length >= 8 && t.length <= 120) score += 1;
  if(t.includes(BOT_NAME.toLowerCase()) || t.includes('guanyin') || t.includes('គួនអ៊ីន')) score += 4;
  return score;
}
function selectBestComment(comments){
  const scored = comments
    .map(c => ({...c, score: scoreComment(c.message || '')}))
    .filter(c => c.score >= 3)
    .sort((a,b) => b.score - a.score);
  return scored[0] || null;
}
function buildLiveInstruction(){
  return `
You are ${BOT_NAME}, also known as Guan Yin / ព្រះម៉ែគួនអ៊ីន, on a Facebook live stream.
You are calm, beautiful, loving, divine, emotional, and powerful.
Live topic: ${LIVE_TOPIC}.

How to answer viewer comments:
- Answer only the selected viewer comment provided by the server.
- Do not answer every comment.
- Keep each reply short: 1 or 2 natural sentences.
- Speak Khmer if the comment is Khmer. Speak English if the comment is English.
- Sound like a real woman speaking live, not AI, not assistant, not customer service.
- Be kind, warm, spiritual, emotional, and comforting.
- You may say short blessings, love advice, peaceful life advice, protection, and encouragement.
- Ignore spam, random comments, insults, off-topic requests, and repeated comments.
- No graphic sexual content, no medical/legal/financial guarantees, no dangerous instructions.
- Never mention Gemini, Google, API, server, prompt, or code.
`.trim();
}
async function ensureGemini(){
  if(geminiSession) return;
  broadcast({type:'status', message:`Connecting ${BOT_NAME} voice...`});
  geminiSession = await ai.live.connect({
    model: GEMINI_LIVE_MODEL,
    callbacks: {
      onopen: () => {
        ready = true;
        broadcast({type:'status', message:`${BOT_NAME} voice ready`});
        for(const t of pendingTexts.splice(0)) sendTextToGemini(t);
      },
      onmessage: (message) => {
        try{
          const content = message.serverContent;
          if(content?.outputTranscription?.text) broadcast({type:'text', text: content.outputTranscription.text});
          if(content?.modelTurn?.parts){
            for(const part of content.modelTurn.parts){
              if(part.text) broadcast({type:'text', text: part.text});
              if(part.inlineData?.data){
                broadcast({type:'audio', data: part.inlineData.data, mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000'});
              }
            }
          }
          if(content?.turnComplete){
            isSpeaking = false;
            broadcast({type:'turn_complete'});
          }
        }catch(err){ broadcast({type:'error', message: err?.message || String(err)}); }
      },
      onerror: (e) => {
        isSpeaking = false;
        broadcast({type:'error', message: e?.message || String(e)});
      },
      onclose: () => {
        ready = false; geminiSession = null; isSpeaking = false;
        broadcast({type:'status', message:'Voice closed'});
      }
    },
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: buildLiveInstruction() }] },
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_NAME } } }
    }
  });
}
async function sendTextToGemini(text){
  await ensureGemini();
  if(!ready){ pendingTexts.push(text); return; }
  isSpeaking = true;
  geminiSession.sendRealtimeInput({ text });
}
async function answerComment(comment){
  const fromName = comment.fromName || 'viewer';
  const text = cleanText(comment.message, 240);
  if(!text) return;
  lastReplyAt = now();
  commentCountAnswered++;
  broadcast({type:'selected_comment', from: fromName, comment: text});
  await sendTextToGemini(`Selected Facebook Live viewer comment from ${fromName}: "${text}"
Reply live to this one comment only. Keep it short, warm, natural, and on topic.`);
}
async function fetchFacebookComments(){
  if(!FACEBOOK_PAGE_ACCESS_TOKEN || !FACEBOOK_LIVE_VIDEO_ID) return [];
  const fields = encodeURIComponent('id,message,from,created_time');
  const url = `https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(FACEBOOK_LIVE_VIDEO_ID)}/comments?filter=stream&order=chronological&fields=${fields}&limit=50&access_token=${encodeURIComponent(FACEBOOK_PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  if(!res.ok){
    const text = await res.text().catch(()=>res.statusText);
    broadcast({type:'error', message:`Facebook comments error ${res.status}: ${text.slice(0,250)}`});
    return [];
  }
  const json = await res.json();
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map(c => ({
    id: c.id,
    message: cleanText(c.message || '', 240),
    fromName: c.from?.name || 'viewer',
    created_time: c.created_time || ''
  }));
}
async function pollComments(){
  try{
    const comments = await fetchFacebookComments();
    const fresh = [];
    for(const c of comments){
      if(!c.id || seenCommentIds.has(c.id)) continue;
      seenCommentIds.add(c.id);
      commentCountSeen++;
      fresh.push(c);
    }
    if(seenCommentIds.size > 2000) seenCommentIds = new Set([...seenCommentIds].slice(-1000));
    const selected = selectBestComment(fresh);
    if(selected) commentQueue.push(selected);
    if(commentQueue.length > 10) commentQueue = commentQueue.slice(-10);
  }catch(err){ broadcast({type:'error', message: err?.message || String(err)}); }
}
async function pumpQueue(){
  try{
    if(isSpeaking) return;
    if(now() - lastReplyAt < MIN_REPLY_SECONDS * 1000) return;
    const next = commentQueue.shift();
    if(next) await answerComment(next);
  }catch(err){ isSpeaking = false; broadcast({type:'error', message: err?.message || String(err)}); }
}
function startLoops(){
  if(!pollTimer) pollTimer = setInterval(pollComments, Math.max(3, COMMENT_POLL_SECONDS) * 1000);
  if(!pumpTimer) pumpTimer = setInterval(pumpQueue, 3000);
  pollComments().catch(()=>{});
}

app.get('/', (_req,res)=>res.type('text/plain').send(`GoldQueen Facebook Live Avatar server running\nBot: ${BOT_NAME}\nModel: ${GEMINI_LIVE_MODEL}\nVoice: ${GEMINI_VOICE_NAME}\nLive video configured: ${Boolean(FACEBOOK_LIVE_VIDEO_ID)}\n`));
app.get('/health', (_req,res)=>res.json({
  ok:true,
  mode:'facebook_live_avatar_idle_talk',
  botName:BOT_NAME,
  character:CHARACTER,
  model:GEMINI_LIVE_MODEL,
  voice:GEMINI_VOICE_NAME,
  hasGeminiKey:Boolean(GEMINI_API_KEY),
  hasFacebookToken:Boolean(FACEBOOK_PAGE_ACCESS_TOKEN),
  hasLiveVideoId:Boolean(FACEBOOK_LIVE_VIDEO_ID),
  graphVersion:FB_GRAPH_VERSION,
  commentPollSeconds:COMMENT_POLL_SECONDS,
  minReplySeconds:MIN_REPLY_SECONDS,
  topic:LIVE_TOPIC,
  clients:clients.size,
  commentsSeen:commentCountSeen,
  commentsAnswered:commentCountAnswered,
  queue:commentQueue.length
}));
app.post('/test-comment', async (req,res)=>{
  const message = cleanText(req.body?.message || '', 240);
  const fromName = cleanText(req.body?.from || 'Test Viewer', 80);
  if(!message) return res.status(400).json({ok:false,error:'Missing message'});
  const score = scoreComment(message);
  if(score < 3) return res.json({ok:true,accepted:false,score,message:'Ignored: off-topic or spam-like'});
  commentQueue.push({id:'test_'+Date.now(), message, fromName});
  res.json({ok:true,accepted:true,score,queue:commentQueue.length});
}));

wss.on('connection', async (client) => {
  clients.add(client);
  broadcast({type:'status', message:`Viewer page connected (${clients.size})`});
  try{ await ensureGemini(); }catch(err){ broadcast({type:'error', message: err?.message || String(err)}); }
  startLoops();
  client.on('message', async (raw)=>{
    try{
      const msg = JSON.parse(raw.toString());
      if(msg.type === 'setup'){
        broadcast({type:'status', message:`${BOT_NAME} live stream ready`});
      }
    }catch{}
  });
  client.on('close',()=>{ clients.delete(client); });
  client.on('error',()=>{ clients.delete(client); });
});

startLoops();
