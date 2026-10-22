import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FacelessShot, FacelessShotMotion, RenderVideoOptions } from './types.js';

const execFileAsync = promisify(execFile);

export function buildZoompanFilter(
  motion: FacelessShotMotion,
  frameCount: number,
  width: number,
  height: number,
  fps: number
): string {
  let expr: string;
  switch (motion) {
    case 'zoom-in':
      expr = "z='min(zoom+0.0015,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
      break;
    case 'zoom-out':
      expr = "z='if(lte(on,1),1.2,max(1.001,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
      break;
    case 'pan-left':
      expr = `z=1.12:x='max(0,iw/2-(iw/zoom/2)+(on/${frameCount})*50)':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'pan-right':
      expr = `z=1.12:x='max(0,iw/2-(iw/zoom/2)-(on/${frameCount})*50)':y='ih/2-(ih/zoom/2)'`;
      break;
    case 'static':
    default:
      expr = "z=1.0:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
      break;
  }
  return `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=${expr}:d=${frameCount}:s=${width}x${height}:fps=${fps},trim=duration=${(frameCount / fps).toFixed(3)}`;
}

export async function renderShotToMp4(input: {
  shot: FacelessShot;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  ffmpegPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { shot, outputPath, width, height, fps, ffmpegPath, signal } = input;
  const frameCount = Math.max(1, Math.ceil(shot.duration * fps));
  const hasValidMedia = shot.mediaPath && existsSync(shot.mediaPath);

  const filter = buildZoompanFilter(shot.motion, frameCount, width, height, fps);

  const args: string[] = ['-y'];

  if (hasValidMedia) {
    args.push('-loop', '1', '-t', String(shot.duration), '-i', shot.mediaPath);
    args.push('-vf', filter);
  } else {
    // Generate black/dark gray video if image is missing
    args.push(
      '-f', 'lavfi',
      '-i', `color=c=0x18181b:s=${width}x${height}:r=${fps}:d=${shot.duration}`
    );
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    outputPath
  );

  await execFileAsync(ffmpegPath, args, { signal, timeout: 180_000 });
}

export async function renderFacelessVideo(options: RenderVideoOptions): Promise<void> {
  const { timeline, audioPath, subtitlePath, outputPath, workdir, ffmpegPath, onProgress, signal } = options;
  const tempDir = join(workdir, 'faceless-render-temp');
  await mkdir(tempDir, { recursive: true });

  const { width, height } = timeline.resolution;
  const fps = timeline.fps;
  const totalShots = timeline.shots.length;
  const shotFiles: string[] = new Array(totalShots);

  try {
    const concurrency = 4;
    let completedShots = 0;

    for (let i = 0; i < totalShots; i += concurrency) {
      if (signal?.aborted) throw new Error('Render canceled');

      const batch = timeline.shots.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (shot, idx) => {
          const shotIndex = i + idx;
          const shotFile = join(tempDir, `shot_${shotIndex}.mp4`);
          shotFiles[shotIndex] = shotFile;

          await renderShotToMp4({
            shot,
            outputPath: shotFile,
            width,
            height,
            fps,
            ffmpegPath,
            signal
          });

          completedShots++;
          onProgress?.({
            phase: 'rendering_shots',
            percent: Math.min(80, Math.round((completedShots / totalShots) * 80)),
            completed: completedShots,
            total: totalShots
          });
        })
      );
    }

    onProgress?.({
      phase: 'concatenating_video',
      percent: 85,
      completed: totalShots,
      total: totalShots
    });

    // Write concat file
    const concatListPath = join(tempDir, 'concat.txt');
    const concatContent = shotFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(concatListPath, concatContent, 'utf8');

    const videoOnlyPath = join(tempDir, 'video_no_audio.mp4');
    await execFileAsync(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      videoOnlyPath
    ], { signal, timeout: 300_000 });

    onProgress?.({
      phase: 'merging_audio_and_subtitles',
      percent: 92,
      completed: totalShots,
      total: totalShots
    });

    const hasAudio = Boolean(audioPath && existsSync(audioPath));
    const hasSubtitles = Boolean(subtitlePath && existsSync(subtitlePath));

    const mergeArgs: string[] = ['-y', '-i', videoOnlyPath];

    if (hasAudio) {
      mergeArgs.push('-i', audioPath!);
    } else {
      // Add silent audio track with exact duration matching video to prevent infinite hangs
      mergeArgs.push('-f', 'lavfi', '-t', String(timeline.totalDuration), '-i', 'anullsrc=r=44100:cl=stereo');
    }

    if (hasSubtitles) {
      mergeArgs.push('-i', subtitlePath!);
    }

    mergeArgs.push('-map', '0:v:0');
    mergeArgs.push('-map', '1:a:0');
    mergeArgs.push('-c:v', 'copy');
    mergeArgs.push('-c:a', 'aac', '-b:a', '192k');

    if (hasSubtitles) {
      mergeArgs.push('-map', '2:s:0');
      mergeArgs.push('-c:s', 'mov_text');
      mergeArgs.push('-metadata:s:s:0', 'language=eng');
    }

    mergeArgs.push('-shortest', '-movflags', '+faststart', outputPath);

    try {
      await execFileAsync(ffmpegPath, mergeArgs, { signal, timeout: 300_000 });
    } catch (err) {
      if (hasSubtitles) {
        // Fallback without subtitles if subtitle muxing or mov_text is rejected by ffmpeg container
        const fallbackArgs = [
          '-y', '-i', videoOnlyPath,
          ...(hasAudio ? ['-i', audioPath!] : ['-f', 'lavfi', '-t', String(timeline.totalDuration), '-i', 'anullsrc=r=44100:cl=stereo']),
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '192k',
          '-shortest', '-movflags', '+faststart', outputPath
        ];
        await execFileAsync(ffmpegPath, fallbackArgs, { signal, timeout: 300_000 });
      } else {
        throw err;
      }
    }

    onProgress?.({
      phase: 'completed',
      percent: 100,
      completed: totalShots,
      total: totalShots
    });
  } finally {
    // Cleanup temporary shot files
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
