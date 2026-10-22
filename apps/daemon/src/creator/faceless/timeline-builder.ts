import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BuildTimelineOptions, FacelessChapter, FacelessShot, FacelessShotMotion, FacelessTimeline } from './types.js';
import { generateYoutubeTimestamps, parseChaptersFromScript } from './chapter-parser.js';

const execFileAsync = promisify(execFile);

export async function probeAudioDuration(audioPath: string, ffprobePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ]);
    const duration = parseFloat(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  } catch (error) {
    console.warn(`[faceless-timeline] ffprobe failed to probe audio: ${error}`);
  }
  return 0;
}

const MOTION_CYCLE: FacelessShotMotion[] = [
  'zoom-in',
  'pan-left',
  'zoom-out',
  'pan-right'
];

export async function buildFacelessTimeline(options: BuildTimelineOptions): Promise<{
  timeline: FacelessTimeline;
  srtContent: string;
}> {
  // 1. Resolve chapters: either provided or parsed from script
  let chapters: FacelessChapter[] = options.chapters && options.chapters.length > 0
    ? [...options.chapters]
    : parseChaptersFromScript(options.script);

  if (chapters.length === 0) {
    chapters = [{
      id: 'chapter-0',
      order: 0,
      title: 'Full Narration',
      text: options.script,
      wordCount: options.script.split(/\s+/).filter(Boolean).length,
      duration: options.targetDuration || (options.targetDurationMinutes ? options.targetDurationMinutes * 60 : 600),
      startOffset: 0
    }];
  } else if (!options.chapters && options.targetDuration && options.targetDuration > 0) {
    // If targetDuration is explicitly specified, scale auto-parsed chapters proportionally
    if (chapters.length === 1) {
      chapters[0]!.duration = options.targetDuration;
    } else {
      const sumWordCount = chapters.reduce((s, c) => s + Math.max(1, c.wordCount || 1), 0);
      let acc = 0;
      for (let i = 0; i < chapters.length; i++) {
        const chap = chapters[i]!;
        const ratio = Math.max(1, chap.wordCount || 1) / sumWordCount;
        chap.duration = i === chapters.length - 1
          ? Math.max(1, Math.round((options.targetDuration - acc) * 100) / 100)
          : Math.max(1, Math.round((options.targetDuration * ratio) * 100) / 100);
        acc += chap.duration;
      }
    }
  }

  // 2. Measure / adjust durations for chapters
  let accumulatedOffset = 0;
  for (let i = 0; i < chapters.length; i++) {
    const chap = chapters[i]!;
    let chapDuration = chap.duration ?? 0;

    if (chap.audioPath && options.ffprobePath) {
      const probed = await probeAudioDuration(chap.audioPath, options.ffprobePath);
      if (probed > 0) {
        chapDuration = probed;
      }
    }

    if (chapDuration <= 0 && chap.wordCount && chap.wordCount > 0) {
      chapDuration = Math.max(5, Math.round(chap.wordCount / 2.33));
    }

    if (chapDuration <= 0) {
      chapDuration = 60; // default 1 min
    }

    chap.duration = Math.round(chapDuration * 100) / 100;
    chap.startOffset = Math.round(accumulatedOffset * 100) / 100;
    accumulatedOffset += chap.duration;
  }

  let totalDuration = Math.round(accumulatedOffset * 100) / 100;

  // If a single audioPath is specified for whole video, probe it
  if (options.audioPath && options.ffprobePath) {
    const probed = await probeAudioDuration(options.audioPath, options.ffprobePath);
    if (probed > 0) {
      totalDuration = probed;
    }
  }

  if (totalDuration <= 0 && options.targetDurationMinutes && options.targetDurationMinutes > 0) {
    totalDuration = options.targetDurationMinutes * 60;
  }

  const imageCount = options.images?.length ?? 0;
  const defaultShotDuration = 5;
  const shots: FacelessShot[] = [];
  const allSrtEntries: string[] = [];
  let srtIndex = 1;
  let globalImageIndex = 0;

  // 3. Build shots per chapter to ensure chapter-level synchronization
  for (let c = 0; c < chapters.length; c++) {
    const chap = chapters[c]!;
    const chapDuration = chap.duration ?? 60;
    const chapShotCount = Math.max(1, Math.ceil(chapDuration / defaultShotDuration));
    chap.shotCount = chapShotCount;

    const chapSentences = chap.text
      .split(/(?<=[.!?\n])\s+/)
      .map(s => s.trim())
      .filter(Boolean);

    let chapAccumulatedTime = 0;
    for (let s = 0; s < chapShotCount; s++) {
      const remainingTime = chapDuration - chapAccumulatedTime;
      const isLastInChap = s === chapShotCount - 1;
      const shotDur = isLastInChap
        ? Math.max(0.1, remainingTime)
        : Math.min(defaultShotDuration, remainingTime);

      const mediaPath = imageCount > 0 ? options.images[globalImageIndex % imageCount]! : '';
      const motion = MOTION_CYCLE[shots.length % MOTION_CYCLE.length]!;

      const sentenceIndex = chapSentences.length > 0
        ? Math.min(chapSentences.length - 1, Math.floor((s / chapShotCount) * chapSentences.length))
        : -1;
      const text = sentenceIndex >= 0 ? (chapSentences[sentenceIndex] ?? '') : '';

      shots.push({
        id: `shot-${shots.length + 1}`,
        order: shots.length,
        duration: Math.round(shotDur * 100) / 100,
        motion,
        mediaPath,
        mediaType: 'image',
        chapterId: chap.id,
        text
      });

      chapAccumulatedTime += shotDur;
      globalImageIndex++;
    }

    // Generate SRT entries for this chapter's sentences
    if (chapSentences.length > 0) {
      const sentenceDur = chapDuration / chapSentences.length;
      const baseOffset = chap.startOffset ?? 0;
      for (let si = 0; si < chapSentences.length; si++) {
        const startSec = baseOffset + si * sentenceDur;
        const endSec = baseOffset + (si + 1) * sentenceDur;
        allSrtEntries.push(
          `${srtIndex++}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${chapSentences[si]}\n`
        );
      }
    }
  }

  const youtubeTimestamps = generateYoutubeTimestamps(chapters);
  const srtContent = allSrtEntries.join('\n');

  const timeline: FacelessTimeline = {
    totalDuration: Math.round(totalDuration * 100) / 100,
    shots,
    chapters,
    youtubeTimestamps,
    audioPath: options.audioPath,
    resolution: options.resolution ?? { width: 1920, height: 1080 },
    fps: options.fps ?? 30
  };

  return { timeline, srtContent };
}

function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);

  const hh = String(hrs).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}
