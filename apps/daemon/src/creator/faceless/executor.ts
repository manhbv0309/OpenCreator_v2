import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreatorExecutor, CreatorExecutorInput, CreatorExecutorResult } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import type { CreatorServicesConfigStore } from '../../creator-services/config-store.js';
import { buildFacelessTimeline } from './timeline-builder.js';
import { renderFacelessVideo } from './ffmpeg-renderer.js';
import { generateDocumentaryScript } from './script-generator.js';
import { parseChaptersFromScript } from './chapter-parser.js';
import { stitchChapterAudios } from './audio-stitcher.js';
import type { FacelessChapter, FacelessTimeline } from './types.js';

export function createFacelessVideoExecutor(input: {
  ffmpegPath?: string;
  ffprobePath?: string;
  configStore?: Pick<CreatorServicesConfigStore, 'read'>;
}): CreatorExecutor {
  return {
    id: 'faceless-video',
    async run(stage: CreatorExecutorInput): Promise<CreatorExecutorResult> {
      const stageId = stage.stageRun.stageId;
      const ffmpeg = input.ffmpegPath;
      const ffprobe = input.ffprobePath;

      if (stageId === 'script') {
        stage.reportProgress({ phase: 'researching_topic', percent: 15 });

        const state = (stage.job.state ?? {}) as Record<string, unknown>;
        const topic = typeof state.topic === 'string' && state.topic.trim()
          ? state.topic.trim()
          : typeof state.title === 'string' && state.title.trim()
            ? state.title.trim()
            : 'Why Japan Has So Many Empty Houses';
        const targetDurationMinutes = typeof state.targetDurationMinutes === 'number'
          ? state.targetDurationMinutes
          : 10;
        const tone = typeof state.tone === 'string' ? state.tone : 'documentary';

        stage.reportProgress({ phase: 'generating_script', percent: 45 });

        const scriptText = await generateDocumentaryScript({
          topic,
          targetDurationMinutes,
          tone,
          configStore: input.configStore,
          signal: stage.signal
        });

        const scriptFileName = 'script.md';
        const scriptPath = join(stage.workdir, scriptFileName);
        await writeFile(scriptPath, scriptText, 'utf8');

        const parsedChapters = parseChaptersFromScript(scriptText);

        stage.reportProgress({ phase: 'completed', percent: 100 });

        return {
          outputs: [
            {
              kind: 'faceless_script',
              status: 'completed',
              path: scriptPath,
              metadata: {
                fileName: scriptFileName,
                script: scriptText,
                topic,
                targetDurationMinutes,
                wordCount: scriptText.split(/\s+/).filter(Boolean).length,
                chapterCount: parsedChapters.length,
                chapters: parsedChapters
              }
            }
          ]
        };
      }

      if (!ffmpeg) {
        throw new CreatorExecutorError(
          'creator_ffmpeg_missing',
          'FFmpeg is required to render faceless videos'
        );
      }

      if (stageId === 'timeline') {
        stage.reportProgress({ phase: 'analyzing_inputs', percent: 10 });

        const state = (stage.job.state ?? {}) as Record<string, unknown>;
        const script = typeof state.script === 'string' ? state.script : '';
        let audioFile = typeof state.audioFile === 'string' && state.audioFile.trim() ? state.audioFile.trim() : undefined;
        const images = Array.isArray(state.images) ? (state.images as string[]) : [];
        const targetDuration = typeof state.targetDuration === 'number' ? state.targetDuration : undefined;
        const targetDurationMinutes = typeof state.targetDurationMinutes === 'number' ? state.targetDurationMinutes : 10;

        // Resolve chapters
        let rawChapters = Array.isArray(state.chapters) && state.chapters.length > 0
          ? (state.chapters as FacelessChapter[])
          : parseChaptersFromScript(script);

        // If chapters have audio files, stitch them together
        const chaptersWithAudio = rawChapters.filter(c => Boolean(c.audioPath));
        let youtubeTimestamps = '';

        if (chaptersWithAudio.length > 0) {
          stage.reportProgress({ phase: 'stitching_chapter_audio', percent: 25 });
          const stitchedAudioPath = join(stage.workdir, 'full_narration.mp3');
          const stitchResult = await stitchChapterAudios({
            chapters: rawChapters,
            outputPath: stitchedAudioPath,
            workdir: stage.workdir,
            ffmpegPath: ffmpeg,
            ffprobePath: ffprobe,
            signal: stage.signal
          });

          if (stitchResult.outputPath) {
            audioFile = stitchResult.outputPath;
          }
          rawChapters = stitchResult.chapters;
          youtubeTimestamps = stitchResult.youtubeTimestamps;
        }

        stage.reportProgress({ phase: 'generating_timeline', percent: 55 });

        const { timeline, srtContent } = await buildFacelessTimeline({
          script,
          chapters: rawChapters,
          audioPath: audioFile,
          images,
          targetDuration,
          targetDurationMinutes,
          ffprobePath: ffprobe
        });

        if (youtubeTimestamps) {
          timeline.youtubeTimestamps = youtubeTimestamps;
        }

        const timelineFileName = 'timeline.json';
        const timelinePath = join(stage.workdir, timelineFileName);
        await writeFile(timelinePath, JSON.stringify(timeline, null, 2), 'utf8');

        const srtFileName = 'subtitles.srt';
        const srtPath = join(stage.workdir, srtFileName);
        await writeFile(srtPath, srtContent, 'utf8');

        const timestampsFileName = 'youtube_timestamps.txt';
        const timestampsPath = join(stage.workdir, timestampsFileName);
        await writeFile(timestampsPath, timeline.youtubeTimestamps || '', 'utf8');

        stage.reportProgress({ phase: 'completed', percent: 100 });

        const outputs: CreatorExecutorResult['outputs'] = [
          {
            kind: 'faceless_timeline',
            status: 'completed',
            path: timelinePath,
            metadata: {
              fileName: timelineFileName,
              totalDuration: timeline.totalDuration,
              shotCount: timeline.shots.length,
              chapterCount: timeline.chapters?.length ?? 0
            }
          },
          {
            kind: 'faceless_subtitles',
            status: 'completed',
            path: srtPath,
            metadata: {
              fileName: srtFileName
            }
          },
          {
            kind: 'faceless_timestamps',
            status: 'completed',
            path: timestampsPath,
            metadata: {
              fileName: timestampsFileName,
              timestamps: timeline.youtubeTimestamps ?? ''
            }
          }
        ];

        if (audioFile) {
          outputs.push({
            kind: 'faceless_narration',
            status: 'completed',
            path: audioFile,
            metadata: {
              fileName: 'full_narration.mp3',
              totalDuration: timeline.totalDuration
            }
          });
        }

        return { outputs };
      }

      if (stageId === 'render') {
        stage.reportProgress({ phase: 'preparing_render', percent: 5 });

        const state = (stage.job.state ?? {}) as Record<string, unknown>;
        let audioFile = typeof state.audioFile === 'string' && state.audioFile.trim() ? state.audioFile.trim() : undefined;

        const timelineArtifact = stage.inputArtifacts.find(a => a.kind === 'faceless_timeline');
        const srtArtifact = stage.inputArtifacts.find(a => a.kind === 'faceless_subtitles');
        const narrationArtifact = stage.inputArtifacts.find(a => a.kind === 'faceless_narration');

        if (!audioFile && narrationArtifact?.path) {
          audioFile = narrationArtifact.path;
        }

        let timeline: FacelessTimeline;
        if (timelineArtifact?.path) {
          const content = await import('node:fs/promises').then(fs => fs.readFile(timelineArtifact.path!, 'utf8'));
          timeline = JSON.parse(content);
          if (!audioFile && timeline.audioPath) {
            audioFile = timeline.audioPath;
          }
        } else {
          // Re-build timeline on the fly if artifact not passed directly
          const script = typeof state.script === 'string' ? state.script : '';
          const images = Array.isArray(state.images) ? (state.images as string[]) : [];
          const targetDurationMinutes = typeof state.targetDurationMinutes === 'number'
            ? state.targetDurationMinutes
            : 10;
          const chapters = Array.isArray(state.chapters) ? (state.chapters as FacelessChapter[]) : undefined;
          const res = await buildFacelessTimeline({
            script,
            chapters,
            audioPath: audioFile,
            images,
            targetDurationMinutes,
            ffprobePath: ffprobe
          });
          timeline = res.timeline;
        }

        const outputFileName = 'final_video.mp4';
        const outputPath = join(stage.workdir, outputFileName);
        const ffmpegExecutable = ffmpeg || 'ffmpeg';

        await renderFacelessVideo({
          timeline,
          audioPath: audioFile,
          subtitlePath: srtArtifact?.path ?? undefined,
          outputPath,
          workdir: stage.workdir,
          ffmpegPath: ffmpegExecutable,
          onProgress: p => stage.reportProgress(p),
          signal: stage.signal
        });

        // Write metadata including YouTube timestamps
        const metadataFileName = 'metadata.json';
        const metadataPath = join(stage.workdir, metadataFileName);
        const metadata = {
          title: typeof state.title === 'string' ? state.title : 'Faceless Documentary Video',
          description: typeof state.script === 'string' ? state.script.slice(0, 500) : '',
          totalDuration: timeline.totalDuration,
          shotCount: timeline.shots.length,
          chapterCount: timeline.chapters?.length ?? 0,
          youtubeTimestamps: timeline.youtubeTimestamps,
          resolution: timeline.resolution,
          fps: timeline.fps,
          generatedAt: new Date().toISOString()
        };
        await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

        return {
          outputs: [
            {
              kind: 'faceless_video',
              status: 'completed',
              path: outputPath,
              metadata: {
                fileName: outputFileName,
                mime: 'video/mp4',
                totalDuration: timeline.totalDuration
              }
            },
            {
              kind: 'faceless_metadata',
              status: 'completed',
              path: metadataPath,
              metadata: {
                fileName: metadataFileName,
                youtubeTimestamps: timeline.youtubeTimestamps ?? ''
              }
            }
          ]
        };
      }

      throw new CreatorExecutorError(
        'creator_stage_unknown',
        `Unknown stageId: ${stageId}`
      );
    }
  };
}
