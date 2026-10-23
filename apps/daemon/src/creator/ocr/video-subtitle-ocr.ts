import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import {
  clusterOcrFrames,
  buildSrtFromCues,
  isSemanticOcrText,
  type ClusteredSubtitleCue,
  type RawOcrFrame
} from './subtitle-clustering.js';
import {
  resolveManagedOcrLanguage,
  type ManagedOcrLanguage
} from './component.js';

const execFileAsync = promisify(execFile);

export type OcrRegion = 'bottom_band' | 'bottom_25' | 'bottom_33' | 'full';

export type VideoSubtitleOcrOptions = {
  videoPath: string;
  ffmpegPath?: string;
  originLang?: string;
  ocrRegion?: OcrRegion;
  fps?: number;
  concurrency?: number;
  signal?: AbortSignal;
  managedLanguage?: ManagedOcrLanguage;
  extractFrames?: (framesDir: string) => Promise<string[]>;
  recognizeFrame?: (path: string) => Promise<string>;
  workdir: string;
  reportProgress?: (progress: {
    phase: string;
    percent: number;
    message: string;
    completed?: number;
    total?: number;
  }) => void;
};

export type VideoSubtitleOcrResult = {
  srtContent: string;
  cues: ClusteredSubtitleCue[];
  cueCount: number;
  frameCount: number;
};

export function mapLanguageToTesseract(lang?: string): string {
  const normalized = lang?.toLowerCase().replaceAll('-', '_') ?? 'en';
  if (normalized === 'zh_tw' || normalized === 'zh_hk' || normalized === 'zh_hant') return 'chi_tra';
  if (normalized.startsWith('zh') || normalized === 'chi') return 'chi_sim';
  if (normalized.startsWith('vi') || normalized === 'vie') return 'vie';
  if (normalized.startsWith('ja') || normalized === 'jpn') return 'jpn';
  if (normalized.startsWith('ko') || normalized === 'kor') return 'kor';
  if (normalized.startsWith('es') || normalized === 'spa') return 'spa';
  if (normalized.startsWith('fr') || normalized === 'fra') return 'fra';
  if (normalized.startsWith('de') || normalized === 'deu') return 'deu';
  if (normalized.startsWith('ru') || normalized === 'rus') return 'rus';
  return 'eng';
}

export function buildCropFilter(region: OcrRegion = 'bottom_band'): string | null {
  switch (region) {
    case 'bottom_band':
      return 'crop=iw*0.90:ih*0.22:iw*0.05:ih*0.65';
    case 'bottom_25':
      return 'crop=iw:ih*0.25:0:ih*0.75';
    case 'bottom_33':
      return 'crop=iw:ih*0.33:0:ih*0.67';
    case 'full':
    default:
      return null;
  }
}

export async function extractVideoSubtitleOcr(
  options: VideoSubtitleOcrOptions
): Promise<VideoSubtitleOcrResult> {
  const {
    videoPath,
    workdir,
    originLang,
    ocrRegion = 'bottom_25',
    fps = 2,
    reportProgress
  } = options;
  throwIfAborted(options.signal);
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const framesDir = join(workdir, 'ocr_frames');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  try {
    reportProgress?.({ phase: 'extracting_ocr_frames', percent: 10, message: 'Extracting video frames for subtitle OCR' });
    let frameFiles: string[];
    if (options.extractFrames) {
      frameFiles = (await options.extractFrames(framesDir)).filter(file => /^frame_\d+\.jpg$/.test(file)).sort();
    } else {
      const crop = buildCropFilter(ocrRegion);
      const vfFilters: string[] = [`fps=${fps}`];
      if (crop) vfFilters.push(crop);
      const framePattern = join(framesDir, 'frame_%05d.jpg');
      await execFileAsync(ffmpeg, [
        '-y', '-nostdin', '-i', videoPath,
        '-vf', vfFilters.join(','), '-q:v', '2', framePattern
      ], { timeout: 300_000, signal: options.signal });
      frameFiles = (await readdir(framesDir)).filter(file => /^frame_\d+\.jpg$/.test(file)).sort();
    }
    if (frameFiles.length === 0) return { srtContent: '', cues: [], cueCount: 0, frameCount: 0 };

    reportProgress?.({
      phase: 'recognizing_video_text', percent: 30,
      message: `Running OCR on ${frameFiles.length} video frames`, completed: 0, total: frameFiles.length
    });
    const rawFrames = await recognizeFrames({ ...options, frameFiles, framesDir, reportProgress });
    throwIfAborted(options.signal);
    reportProgress?.({
      phase: 'merging_ocr_subtitles', percent: 90,
      message: 'Clustering OCR frames and formatting subtitles', completed: frameFiles.length, total: frameFiles.length
    });
    const cues = clusterOcrFrames(rawFrames, {
      frameIntervalSec: 1 / fps,
      minDurationMs: 400,
      similarityThreshold: 0.75
    });
    return { srtContent: buildSrtFromCues(cues), cues, cueCount: cues.length, frameCount: frameFiles.length };
  } finally {
    await rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeFrames(input: VideoSubtitleOcrOptions & {
  frameFiles: string[];
  framesDir: string;
}): Promise<RawOcrFrame[]> {
  const frameIntervalSec = 1 / (input.fps ?? 2);
  const output: Array<RawOcrFrame | undefined> = new Array(input.frameFiles.length);
  let completed = 0;
  if (input.recognizeFrame) {
    await runPool(input.frameFiles.length, input.concurrency ?? 2, input.signal, async index => {
      const text = (await input.recognizeFrame!(join(input.framesDir, input.frameFiles[index]!))).trim();
      if (text && text.toUpperCase() !== 'EMPTY' && isSemanticOcrText(text)) {
        output[index] = frameResult(input.frameFiles[index]!, index, frameIntervalSec, text);
      }
      completed += 1;
      reportRecognitionProgress(input, completed);
    });
    return output.filter((frame): frame is RawOcrFrame => frame !== undefined);
  }

  const language = input.managedLanguage ?? await resolveManagedOcrLanguage(input.originLang);
  const workerCount = Math.max(1, Math.min(
    input.concurrency ?? Math.min(2, availableParallelism()),
    input.frameFiles.length
  ));
  const workers = await Promise.all(Array.from({ length: workerCount }, async () => {
    throwIfAborted(input.signal);
    const worker = await Tesseract.createWorker(language.code, Tesseract.OEM.LSTM_ONLY, {
      langPath: language.langPath,
      gzip: true,
      cacheMethod: 'none'
    });
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    return worker;
  }));
  let next = 0;
  const abort = () => { void Promise.allSettled(workers.map(worker => worker.terminate())); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(workers.map(async worker => {
      while (true) {
        throwIfAborted(input.signal);
        const index = next++;
        if (index >= input.frameFiles.length) return;
        const framePath = join(input.framesDir, input.frameFiles[index]!);
        const preprocessed = await prepareFrameForOcr(framePath);
        const result = await worker.recognize(preprocessed);
        const text = result.data.text.trim();
        const conf = result.data.confidence;
        if (text && conf >= 45 && isSemanticOcrText(text)) {
          output[index] = frameResult(input.frameFiles[index]!, index, frameIntervalSec, text);
        }
        completed += 1;
        reportRecognitionProgress(input, completed);
      }
    }));
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
  return output.filter((frame): frame is RawOcrFrame => frame !== undefined);
}

async function prepareFrameForOcr(framePath: string): Promise<Buffer | string> {
  try {
    const meta = await sharp(framePath).metadata();
    if (meta.width && meta.height) {
      const targetWidth = Math.max(1000, meta.width * 2);
      return await sharp(framePath)
        .grayscale()
        .normalize()
        .sharpen()
        .resize({ width: targetWidth })
        .extend({ top: 30, bottom: 30, left: 30, right: 30, background: '#ffffff' })
        .png()
        .toBuffer();
    }
  } catch {
    // fallback to original path if sharp fails
  }
  return framePath;
}

function frameResult(file: string, fallbackIndex: number, interval: number, text: string): RawOcrFrame {
  const match = /frame_(\d+)\.jpg$/.exec(file);
  const index = match ? Number(match[1]) - 1 : fallbackIndex;
  return { timeSec: index * interval, text };
}

function reportRecognitionProgress(
  input: Pick<VideoSubtitleOcrOptions, 'reportProgress'> & { frameFiles: string[] },
  completed: number
) {
  input.reportProgress?.({
    phase: 'recognizing_video_text',
    percent: 30 + Math.round((completed / input.frameFiles.length) * 55),
    message: `Recognizing text in video (${completed}/${input.frameFiles.length})`,
    completed,
    total: input.frameFiles.length
  });
}

async function runPool(
  count: number,
  concurrency: number,
  signal: AbortSignal | undefined,
  run: (index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= count) return;
      await run(index);
    }
  }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Creator stage was canceled'), { code: 'creator_stage_canceled' });
}
