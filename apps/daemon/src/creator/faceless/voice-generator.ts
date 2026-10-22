import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DOCUMENTARY_VOICES = [
  {
    id: 'en-US-ChristopherNeural',
    name: 'Christopher (US - Deep Documentary)',
    gender: 'Male',
    description: 'Deep, authoritative, documentary (National Geographic style)',
    recommended: true
  },
  {
    id: 'en-US-GuyNeural',
    name: 'Guy (US - News & Investigative)',
    gender: 'Male',
    description: 'Engaging, clear, investigative reporting'
  },
  {
    id: 'en-GB-RyanNeural',
    name: 'Ryan (UK - BBC Style)',
    gender: 'Male',
    description: 'Sophisticated, classic British narrator'
  },
  {
    id: 'en-US-JennyNeural',
    name: 'Jenny (US - Warm & Expressive)',
    gender: 'Female',
    description: 'Warm, engaging, natural documentary narrator'
  },
  {
    id: 'en-US-EricNeural',
    name: 'Eric (US - Conversational)',
    gender: 'Male',
    description: 'Conversational, modern YouTube deep-dive style'
  }
] as const;

export function cleanScriptForNarration(script: string): string {
  if (!script || !script.trim()) return '';

  return script
    // Remove markdown headers: # Title, ## [HOOK & INTRO], etc.
    .replace(/^#+\s+.*$/gm, '')
    // Remove bracket cues: [Visual: ...], [Hook], [Intro], [B-Roll: ...], [Sound: ...]
    .replace(/\[(?:Visual|Hook|Intro|Chapter|Sound|Music|B-Roll|Graphic|Footage)[^\]]*\]/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Normalize punctuation & whitespace
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function synthesizeEdgeTtsChunk(options: {
  text: string;
  voiceId?: string;
  speed?: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { text, voiceId = 'en-US-ChristopherNeural', speed = 1.0, signal } = options;
  if (!text.trim()) return Buffer.alloc(0);

  // Calculate rate string for SSML
  const speedDiff = Math.round((speed - 1.0) * 100);
  const rateStr = speedDiff >= 0 ? `+${speedDiff}%` : `${speedDiff}%`;

  const connectionId = randomUUID().replace(/-/g, '');
  const requestId = randomUUID().replace(/-/g, '');
  const wssUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA654081839223875B3194EC&ConnectionId=${connectionId}`;

  const escaped = escapeSsmlText(text.trim());
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voiceId}'>` +
    `<prosody pitch='+0Hz' rate='${rateStr}'>` +
    `${escaped}` +
    `</prosody>` +
    `</voice>` +
    `</speak>`;

  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('TTS synthesis aborted'));

    const ws = new globalThis.WebSocket(wssUrl, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
      }
    } as never);

    const audioChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Edge-TTS synthesis timed out after 60s'));
    }, 60_000);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      try { ws.close(); } catch {}
      reject(new Error('TTS synthesis aborted'));
    };

    signal?.addEventListener('abort', onAbort);

    ws.onopen = () => {
      // 1. Send speech.config
      const configMessage =
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false'
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
              }
            }
          }
        });
      ws.send(configMessage);

      // 2. Send SSML
      const ssmlMessage =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml;
      ws.send(ssmlMessage);
    };

    ws.onmessage = async (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) {
          cleanup();
          try { ws.close(); } catch {}
          resolve(Buffer.concat(audioChunks));
        }
      } else {
        // Binary audio packet
        let buf: Buffer;
        if (event.data instanceof ArrayBuffer) {
          buf = Buffer.from(event.data);
        } else if (event.data instanceof Blob) {
          const ab = await event.data.arrayBuffer();
          buf = Buffer.from(ab);
        } else {
          buf = Buffer.from(event.data as never);
        }

        // Binary frame format: [2-byte header length][header string][audio data]
        if (buf.length > 2) {
          const headerLength = buf.readUInt16BE(0);
          if (buf.length > headerLength + 2) {
            const headerStr = buf.subarray(2, headerLength + 2).toString('utf8');
            if (headerStr.includes('Path:audio')) {
              const audioData = buf.subarray(headerLength + 2);
              if (audioData.length > 0) {
                audioChunks.push(audioData);
              }
            }
          }
        }
      }
    };

    ws.onerror = (err: Event) => {
      cleanup();
      reject(new Error(`Edge-TTS WebSocket error: ${String(err)}`));
    };

    ws.onclose = () => {
      cleanup();
      if (audioChunks.length > 0) {
        resolve(Buffer.concat(audioChunks));
      } else {
        reject(new Error('Edge-TTS connection closed without audio'));
      }
    };
  });
}

export async function synthesizeFullScript(options: {
  script: string;
  voiceId?: string;
  speed?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<Buffer> {
  const { script, voiceId = 'en-US-ChristopherNeural', speed = 1.0, signal, onProgress } = options;
  const cleanText = cleanScriptForNarration(script);
  if (!cleanText.trim()) throw new Error('No narration text found in script');

  // Split into chunks of ~1200 characters at sentence boundaries to avoid WebSocket packet limits
  const paragraphs = cleanText.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    if ((currentChunk + '\n\n' + para).length < 1200) {
      currentChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      if (para.length > 1200) {
        // Split very long paragraph by sentences
        const sentences = para.split(/(?<=[.!?])\s+/);
        let sub = '';
        for (const s of sentences) {
          if ((sub + ' ' + s).length < 1200) {
            sub = sub ? `${sub} ${s}` : s;
          } else {
            if (sub) chunks.push(sub);
            sub = s;
          }
        }
        if (sub) currentChunk = sub;
        else currentChunk = '';
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  const audioBuffers: Buffer[] = [];
  const totalChunks = chunks.length;

  for (let i = 0; i < totalChunks; i++) {
    if (signal?.aborted) throw new Error('Synthesis canceled');
    const chunkText = chunks[i]!;

    onProgress?.(Math.round(((i + 0.1) / totalChunks) * 100));

    const chunkAudio = await synthesizeEdgeTtsChunk({
      text: chunkText,
      voiceId,
      speed,
      signal
    });

    audioBuffers.push(chunkAudio);
  }

  onProgress?.(100);
  return Buffer.concat(audioBuffers);
}

export async function measureAudioDuration(audioPath: string, ffprobePath?: string): Promise<number> {
  if (ffprobePath) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath
      ]);
      const dur = parseFloat(stdout.trim());
      if (Number.isFinite(dur) && dur > 0) return Math.round(dur * 100) / 100;
    } catch {
      // Fallback below
    }
  }
  return 600; // 10 mins fallback
}

export async function generateFacelessVoiceover(options: {
  script: string;
  outputPath: string;
  voiceId?: string;
  speed?: number;
  ffprobePath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; percent: number }) => void;
}): Promise<{ duration: number; outputPath: string }> {
  const { script, outputPath, voiceId, speed, ffprobePath, signal, onProgress } = options;

  onProgress?.({ phase: 'synthesizing_voice', percent: 10 });

  const audioBuffer = await synthesizeFullScript({
    script,
    voiceId,
    speed,
    signal,
    onProgress: p => onProgress?.({ phase: 'synthesizing_voice', percent: Math.min(90, Math.max(10, p)) })
  });

  await writeFile(outputPath, audioBuffer);

  onProgress?.({ phase: 'measuring_audio', percent: 95 });

  const duration = await measureAudioDuration(outputPath, ffprobePath);

  onProgress?.({ phase: 'voice_ready', percent: 100 });

  return { duration, outputPath };
}
