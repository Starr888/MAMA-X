import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in environment variables.');
  process.exit(1);
}

const app = express();

app.get('/', (_req, res) => {
  res.type('text/plain').send('MAMA X Gemini Live server is running.');
});

const server = app.listen(PORT, () => {
  console.log(`MAMA X Gemini Live server listening on ${PORT}`);
});

const wss = new WebSocketServer({ server });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function safeSend(client, payload) {
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify(payload));
  }
}

wss.on('connection', async (client) => {
  let geminiSession = null;
  let ready = false;
  let pendingAudio = [];

  safeSend(client, { type: 'status', message: 'Browser connected to bridge.' });

  async function startGeminiSession(systemInstruction) {
    if (geminiSession) return;

    safeSend(client, { type: 'status', message: 'Connecting Gemini Live...' });

    geminiSession = await ai.live.connect({
      model: GEMINI_MODEL,
      callbacks: {
        onopen: () => {
          ready = true;
          safeSend(client, { type: 'status', message: 'Gemini Live connected.' });

          for (const item of pendingAudio) {
            geminiSession.sendRealtimeInput(item);
          }
          pendingAudio = [];
        },

        onmessage: (message) => {
          try {
            const content = message.serverContent;

            // Audio output: Gemini sends raw 24kHz PCM as base64.
            if (content?.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  safeSend(client, {
                    type: 'audio',
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000'
                  });
                }

                if (part.text) {
                  safeSend(client, { type: 'text', text: part.text });
                }
              }
            }

            // Optional transcription if available.
            if (content?.outputTranscription?.text) {
              safeSend(client, { type: 'text', text: content.outputTranscription.text });
            }
          } catch (err) {
            safeSend(client, { type: 'error', message: err.message || String(err) });
          }
        },

        onerror: (e) => {
          safeSend(client, { type: 'error', message: e.message || String(e) });
        },

        onclose: (e) => {
          ready = false;
          safeSend(client, { type: 'status', message: 'Gemini Live closed: ' + (e.reason || '') });
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: systemInstruction || 'You are a friendly, concise voice chat character.' }]
        },
        outputAudioTranscription: {}
      }
    });
  }

  client.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'setup') {
        await startGeminiSession(msg.systemInstruction);
        return;
      }

      if (!geminiSession) {
        await startGeminiSession('You are a friendly, concise voice chat character.');
      }

      if (msg.type === 'text' && msg.text) {
        const input = { text: msg.text };
        if (ready) geminiSession.sendRealtimeInput(input);
        return;
      }

      if (msg.type === 'audio' && msg.data) {
        const input = {
          audio: {
            data: msg.data,
            mimeType: msg.mimeType || 'audio/pcm;rate=16000'
          }
        };

        if (ready) {
          geminiSession.sendRealtimeInput(input);
        } else {
          pendingAudio.push(input);
        }
        return;
      }

      if (msg.type === 'end_turn') {
        // For Live API realtime audio, voice activity usually detects turns.
        // This message is kept for future manual turn control.
        safeSend(client, { type: 'status', message: 'Voice turn ended.' });
        return;
      }
    } catch (err) {
      safeSend(client, { type: 'error', message: err.message || String(err) });
    }
  });

  client.on('close', () => {
    try {
      if (geminiSession) geminiSession.close();
    } catch {}
  });
});
