import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  clusterOcrFrames,
  buildSrtFromCues,
  type ClusteredSubtitleCue,
  type RawOcrFrame
} from './subtitle-clustering.js';

const execFileAsync = promisify(execFile);

export type OcrRegion = 'bottom_25' | 'bottom_33' | 'full';

export type VideoSubtitleOcrOptions = {
  videoPath: string;
  ffmpegPath?: string;
  tesseractPath?: string;
  originLang?: string;
  ocrRegion?: OcrRegion;
  fps?: number;
  workdir: string;
  reportProgress?: (progress: { phase: string; percent: number; message: string }) => void;
};

export type VideoSubtitleOcrResult = {
  srtContent: string;
  cues: ClusteredSubtitleCue[];
  cueCount: number;
  frameCount: number;
};

export function resolveTesseractExecutable(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) return explicitPath;
  const candidates = [
    process.env.OPENCREATOR_TESSERACT_PATH,
    process.platform === 'win32' ? 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' : undefined,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe' : undefined,
    '/usr/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/opt/homebrew/bin/tesseract'
  ];
  return candidates.find(candidate => candidate !== undefined && existsSync(candidate));
}

export function mapLanguageToTesseract(lang?: string): string {
  if (!lang) return 'eng';
  const normalized = lang.toLowerCase().replace(/[-_]/g, '');
  if (normalized.startsWith('zh') || normalized === 'chi') return 'chi_sim+eng';
  if (normalized.startsWith('vi') || normalized === 'vie') return 'vie+eng';
  if (normalized.startsWith('ja') || normalized === 'jpn') return 'jpn+eng';
  if (normalized.startsWith('ko') || normalized === 'kor') return 'kor+eng';
  if (normalized.startsWith('es') || normalized === 'spa') return 'spa+eng';
  if (normalized.startsWith('fr') || normalized === 'fra') return 'fra+eng';
  if (normalized.startsWith('de') || normalized === 'deu') return 'deu+eng';
  if (normalized.startsWith('ru') || normalized === 'rus') return 'rus+eng';
  return 'eng';
}

export function buildCropFilter(region: OcrRegion = 'bottom_25'): string | null {
  switch (region) {
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

  const tesseract = resolveTesseractExecutable(options.tesseractPath);
  if (!tesseract) {
    throw new Error(
      'Tesseract OCR executable not found. Please install Tesseract-OCR on your system or specify OPENCREATOR_TESSERACT_PATH.'
    );
  }

  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const framesDir = join(workdir, 'ocr_frames');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  reportProgress?.({
    phase: 'extracting_ocr_frames',
    percent: 10,
    message: 'Extracting video frames for subtitle OCR'
  });

  const crop = buildCropFilter(ocrRegion);
  const vfFilters: string[] = [`fps=${fps}`];
  if (crop) vfFilters.push(crop);

  const framePattern = join(framesDir, 'frame_%05d.jpg');
  await execFileAsync(ffmpeg, [
    '-y',
    '-i', videoPath,
    '-vf', vfFilters.join(','),
    '-q:v', '2',
    framePattern
  ], { timeout: 300_000 });

  const frameFiles = (await readdir(framesDir))
    .filter(file => /^frame_\d+\.jpg$/.test(file))
    .sort();

  if (frameFiles.length === 0) {
    return {
      srtContent: '',
      cues: [],
      cueCount: 0,
      frameCount: 0
    };
  }

  reportProgress?.({
    phase: 'recognizing_video_text',
    percent: 30,
    message: `Running OCR on ${frameFiles.length} video frames`
  });

  const tessLang = mapLanguageToTesseract(originLang);
  const rawFrames: RawOcrFrame[] = [];
  const frameIntervalSec = 1 / fps;

  for (let i = 0; i < frameFiles.length; i++) {
    const frameFile = frameFiles[i]!;
    const framePath = join(framesDir, frameFile);
    const frameIndexMatch = /frame_(\d+)\.jpg$/.exec(frameFile);
    const frameIndex = frameIndexMatch ? Number(frameIndexMatch[1]) - 1 : i;
    const timeSec = frameIndex * frameIntervalSec;

    try {
      const { stdout } = await execFileAsync(tesseract, [
        framePath,
        'stdout',
        '-l', tessLang,
        '--psm', '6'
      ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });

      const text = stdout.trim();
      if (text) {
        rawFrames.push({ timeSec, text });
      }
    } catch {
      // If language specific model fails, try fallback to eng
      if (tessLang !== 'eng') {
        try {
          const { stdout } = await execFileAsync(tesseract, [
            framePath,
            'stdout',
            '-l', 'eng',
            '--psm', '6'
          ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
          const text = stdout.trim();
          if (text) rawFrames.push({ timeSec, text });
        } catch {
          // Skip frame on failure
        }
      }
    }

    if (i % 20 === 0 && reportProgress) {
      const currentPercent = 30 + Math.round((i / frameFiles.length) * 55);
      reportProgress({
        phase: 'recognizing_video_text',
        percent: currentPercent,
        message: `Recognizing text in video (${i + 1}/${frameFiles.length})`
      });
    }
  }

  reportProgress?.({
    phase: 'merging_ocr_subtitles',
    percent: 90,
    message: 'Clustering OCR frames and formatting subtitles'
  });

  const cues = clusterOcrFrames(rawFrames, {
    frameIntervalSec,
    minDurationMs: 400,
    similarityThreshold: 0.75
  });

  const srtContent = buildSrtFromCues(cues);

  // Clean up frames directory after OCR
  await rm(framesDir, { recursive: true, force: true }).catch(() => {});

  return {
    srtContent,
    cues,
    cueCount: cues.length,
    frameCount: frameFiles.length
  };
}
