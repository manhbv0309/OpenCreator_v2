import type {
  FacelessChapter,
  FacelessShot,
  FacelessShotMotion,
  FacelessTimeline,
  FacelessVideoInput
} from '@opencreator/protocol';

export type {
  FacelessChapter,
  FacelessShot,
  FacelessShotMotion,
  FacelessTimeline,
  FacelessVideoInput
};

export type BuildTimelineOptions = {
  script: string;
  chapters?: FacelessChapter[];
  audioPath?: string;
  images: string[];
  targetDuration?: number;
  targetDurationMinutes?: number;
  ffprobePath?: string;
  resolution?: { width: number; height: number };
  fps?: number;
};

export type RenderVideoOptions = {
  timeline: FacelessTimeline;
  audioPath?: string;
  subtitlePath?: string;
  outputPath: string;
  workdir: string;
  ffmpegPath: string;
  onProgress?: (progress: { phase: string; percent: number; completed: number; total: number }) => void;
  signal?: AbortSignal;
};

export type DeliveryPackageManifest = {
  version: 1;
  templateId: 'faceless-video';
  title: string;
  totalDuration: number;
  files: {
    video: string;
    subtitles?: string;
    metadata: string;
  };
  generatedAt: string;
};
