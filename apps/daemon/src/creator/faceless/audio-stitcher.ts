import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FacelessChapter } from './types.js';
import { formatYoutubeTimestamp, generateYoutubeTimestamps } from './chapter-parser.js';

const execFileAsync = promisify(execFile);

export async function probeAudioDuration(audioPath: string, ffprobePath?: string): Promise<number> {
  if (!ffprobePath) return 0;
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ]);
    const duration = parseFloat(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) {
      return Math.round(duration * 100) / 100;
    }
  } catch (error) {
    console.warn(`[audio-stitcher] ffprobe failed to probe audio (${audioPath}): ${error}`);
  }
  return 0;
}

export type StitchAudioOptions = {
  chapters: FacelessChapter[];
  outputPath: string;
  workdir: string;
  ffmpegPath: string;
  ffprobePath?: string;
  signal?: AbortSignal;
};

export type StitchAudioResult = {
  outputPath: string;
  totalDuration: number;
  chapters: FacelessChapter[];
  youtubeTimestamps: string;
};

/**
 * Probes and synchronizes chapter audio durations and start offsets.
 * If multiple chapter audio files are provided, concatenates them into a single master audio file.
 */
export async function stitchChapterAudios(options: StitchAudioOptions): Promise<StitchAudioResult> {
  const { chapters, outputPath, workdir, ffmpegPath, ffprobePath } = options;

  if (chapters.length === 0) {
    throw new Error('No chapters provided to stitch audio');
  }

  // 1. Probe duration for each chapter
  const updatedChapters: FacelessChapter[] = [];
  let currentOffset = 0;

  for (let i = 0; i < chapters.length; i++) {
    const chap = { ...chapters[i]! };
    let chapDuration = chap.duration ?? 0;

    if (chap.audioPath && ffprobePath) {
      const probed = await probeAudioDuration(chap.audioPath, ffprobePath);
      if (probed > 0) {
        chapDuration = probed;
      }
    }

    if (chapDuration <= 0 && chap.wordCount && chap.wordCount > 0) {
      chapDuration = Math.max(5, Math.round(chap.wordCount / 2.33));
    }

    chap.duration = chapDuration;
    chap.startOffset = currentOffset;
    currentOffset += chapDuration;

    updatedChapters.push(chap);
  }

  const totalDuration = Math.round(currentOffset * 100) / 100;
  const youtubeTimestamps = generateYoutubeTimestamps(updatedChapters);

  // 2. Check if we have audio files to concatenate
  const chaptersWithAudio = updatedChapters.filter(c => Boolean(c.audioPath));

  if (chaptersWithAudio.length === 0) {
    // No audio files present
    return {
      outputPath: '',
      totalDuration,
      chapters: updatedChapters,
      youtubeTimestamps
    };
  }

  if (chaptersWithAudio.length === 1 && updatedChapters.length === 1 && chaptersWithAudio[0]?.audioPath) {
    // Single chapter with audio
    return {
      outputPath: chaptersWithAudio[0].audioPath,
      totalDuration,
      chapters: updatedChapters,
      youtubeTimestamps
    };
  }

  // 3. Multi-chapter concatenation via FFmpeg concat demuxer
  // Write concat manifest
  const concatListLines: string[] = [];
  for (const chap of updatedChapters) {
    if (chap.audioPath) {
      // Escape single quotes for ffmpeg concat demuxer
      const safePath = chap.audioPath.replace(/'/g, "'\\''");
      concatListLines.push(`file '${safePath}'`);
    }
  }

  if (concatListLines.length === 0) {
    return {
      outputPath: '',
      totalDuration,
      chapters: updatedChapters,
      youtubeTimestamps
    };
  }

  const concatManifestPath = join(workdir, 'chapter_audio_concat.txt');
  await writeFile(concatManifestPath, concatListLines.join('\n'), 'utf8');

  // Attempt stream copy first for maximum speed
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatManifestPath,
      '-c', 'copy',
      outputPath
    ]);
  } catch (copyError) {
    console.warn(`[audio-stitcher] Concat copy failed, falling back to re-encoding: ${copyError}`);
    // Fallback: re-encode to high quality MP3
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatManifestPath,
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      outputPath
    ]);
  }

  // Probe final stitched audio duration if ffprobe is available
  let finalDuration = totalDuration;
  if (ffprobePath) {
    const probedTotal = await probeAudioDuration(outputPath, ffprobePath);
    if (probedTotal > 0) {
      finalDuration = probedTotal;
    }
  }

  return {
    outputPath,
    totalDuration: finalDuration,
    chapters: updatedChapters,
    youtubeTimestamps
  };
}
