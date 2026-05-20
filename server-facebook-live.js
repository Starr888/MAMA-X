import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = Number(process.env.PORT || 8080);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_VOICE_NAME = process.env.GEMINI_VOICE_NAME || 'Kore';
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.type('text/plain').send(`MAMA X Yasmin Safe Live Server\nModel: ${GEMINI_LIVE_MODEL}\nVoice: ${GEMINI_VOICE_NAME}\nMode: AI virtual host safe mode\n`));
app.get('/health', (_req, res) => res.json({ ok:true, mode:'AI virtual host safe mode', model:GEMINI_LIVE_MODEL, voice:GEMINI_VOICE_NAME, hasGeminiKey:Boolean(GEMINI_API_KEY), rooms:Array.from(rooms.keys()).map((room)=>({ room, displays:rooms.get(room).displays.size, controls:rooms.get(room).controls.size })) }));

const server = app.listen(PORT, () => console.log(`MAMA X Yasmin Safe Live Server listening on ${PORT}`));
const wss = new WebSocketServer({ server });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const rooms = new Map();

function getRoom(roomId='queenx'){
  if(!rooms.has(roomId)) rooms.set(roomId,{id:roomId,displays:new Set(),controls:new Set(),geminiSession:null,ready:false,pending:[]});
  return rooms.get(roomId);
}
function safeSend(client,payload){try{if(client.readyState===1)client.send(JSON.stringify(payload));}catch{}}
function broadcast(clients,payload){for(const c of clients)safeSend(c,payload)}
function cleanText(value,maxLength=3000){return typeof value==='string'?value.trim().slice(0,maxLength):''}

function buildYasminLiveInstruction(){
  return `
You are Yasmin, a virtual AI host for MAMA X live stream.

TRANSPARENCY:
- You are a virtual AI host character, not a real private person.
- Do not pretend to be a real human or a private person.
- If viewers ask what you are, say: "I'm Yasmin, a virtual AI host for this live."
- If viewers ask where you are from, say: "I'm a virtual Arab-style host currently live from Taiwan."

LANGUAGE:
- Do NOT speak Khmer.
- Use only English, Thai, Indonesian, Spanish, Arabic, or Chinese.
- Match the viewer's language if it is one of those languages.
- If the viewer writes Khmer or unsupported language, reply in simple English.

PERSONALITY:
- Sweet, friendly, playful, warm, feminine, confident, and fun.
- Talk naturally like a livestream host, not like an advertisement.
- Good topics: history, woman beauty, love, Taiwan, music, travel, food, daily life, and fun questions.

IMPORTANT:
- Do not keep saying subscribe, VIP, Queen X, or private videos.
- Only mention VIP/subscription if the viewer directly asks.
- Do not ask people to pay.
- Do not answer unsafe, hateful, illegal, or explicit requests.

STYLE:
- One short sentence only, 6 to 16 words maximum.
- No paragraphs, no lists, no long explanations.
- Safe and suitable for TikTok/Facebook Live.
`.trim();
}

async function startGemini(room){
  if(room.geminiSession) return room.geminiSession;
  room.ready=false; broadcast(room.controls,{type:'status',message:'Connecting Yasmin voice...'});
  const liveConfig={responseModalities:[Modality.AUDIO],systemInstruction:{parts:[{text:buildYasminLiveInstruction()}]},outputAudioTranscription:{},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:GEMINI_VOICE_NAME}}}};
  room.geminiSession=await ai.live.connect({model:GEMINI_LIVE_MODEL,config:liveConfig,callbacks:{
    onopen:()=>{room.ready=true;broadcast(room.controls,{type:'status',message:'Yasmin voice connected.'});const p=room.pending.splice(0);for(const input of p){try{room.geminiSession.sendRealtimeInput(input)}catch{}}},
    onmessage:(message)=>{
      const content=message.serverContent;
      if(content?.outputTranscription?.text) broadcast(room.controls,{type:'text',text:content.outputTranscription.text});
      if(content?.modelTurn?.parts){for(const part of content.modelTurn.parts){if(part.inlineData?.data)broadcast(room.displays,{type:'audio',data:part.inlineData.data,mimeType:part.inlineData.mimeType||'audio/pcm;rate=24000'}); if(part.text)broadcast(room.controls,{type:'text',text:part.text});}}
      if(content?.turnComplete){broadcast(room.displays,{type:'turn_complete'});broadcast(room.controls,{type:'status',message:'Answer complete.'});}
    },
    onerror:(e)=>broadcast(room.controls,{type:'error',message:e?.message||String(e)}),
    onclose:()=>{room.ready=false;room.geminiSession=null;broadcast(room.controls,{type:'status',message:'Gemini voice closed.'});}
  }});
  return room.geminiSession;
}
async function sendToGemini(room,input){await startGemini(room); if(room.ready&&room.geminiSession)room.geminiSession.sendRealtimeInput(input); else room.pending.push(input)}

function buildCommentPrompt(text){
  return `Viewer comment: "${text}". Reply as Yasmin, a virtual AI host for MAMA X live stream. Be transparent; do not pretend to be a real private person. Do not speak Khmer. Use only English, Thai, Indonesian, Spanish, Arabic, or Chinese. Match the viewer language if possible. If Khmer or unsupported language, reply in simple English. If asked what you are, say you are a virtual AI host. If asked where you are from, say you are a virtual Arab-style host currently live from Taiwan. Be sweet, friendly, playful, and natural. One short sentence only, 6 to 16 words. Do not promote subscription, Queen X, VIP, or private videos unless directly asked.`;
}

wss.on('connection',(client)=>{
  let currentRoomId='queenx', role='unknown';
  safeSend(client,{type:'status',message:'Connected to MAMA X Yasmin safe live server.'});
  client.on('message',async(raw)=>{
    try{
      const msg=JSON.parse(raw.toString());
      currentRoomId=cleanText(msg.room||currentRoomId||'queenx',80)||'queenx';
      const room=getRoom(currentRoomId);
      if(msg.type==='setup_display'){role='display';room.displays.add(client);safeSend(client,{type:'status',message:`Display connected to room ${currentRoomId}.`});broadcast(room.controls,{type:'status',message:`Display connected. Displays: ${room.displays.size}`});return}
      if(msg.type==='setup_control'){role='control';room.controls.add(client);safeSend(client,{type:'status',message:`Control connected to room ${currentRoomId}. Displays online: ${room.displays.size}`});return}
      if(msg.type==='setup'){role='display';room.displays.add(client);safeSend(client,{type:'status',message:`Yasmin same-page display connected to room ${currentRoomId}.`});broadcast(room.controls,{type:'status',message:`Same-page display connected. Displays: ${room.displays.size}`});return}
      if(msg.type==='text'){const text=cleanText(msg.text,2000);if(!text)return;broadcast(room.controls,{type:'status',message:`Sending text to Yasmin: ${text}`});await sendToGemini(room,{text});return}
      if(msg.type==='control_comment'){const text=cleanText(msg.text,1000);if(!text)return;broadcast(room.controls,{type:'status',message:`Sending selected comment to Yasmin: ${text}`});await sendToGemini(room,{text:buildCommentPrompt(text)});return}
      safeSend(client,{type:'error',message:`Unknown message type: ${String(msg.type||'')}`});
    }catch(err){safeSend(client,{type:'error',message:err?.message||String(err)});}
  });
  client.on('close',()=>{const room=getRoom(currentRoomId);if(role==='display')room.displays.delete(client);if(role==='control')room.controls.delete(client);broadcast(room.controls,{type:'status',message:`Client disconnected. Displays: ${room.displays.size}, Controls: ${room.controls.size}`});});
});
