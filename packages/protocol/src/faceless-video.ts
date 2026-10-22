export const facelessShotMotions = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'static'
] as const;

export type FacelessShotMotion = (typeof facelessShotMotions)[number];

export type FacelessShot = {
  id: string;
  order: number;
  text?: string;
  duration: number;
  motion: FacelessShotMotion;
  mediaPath: string;
  mediaType: 'image' | 'video';
  chapterId?: string;
};

export type FacelessChapter = {
  id: string;
  order: number;
  title: string;
  text: string;
  wordCount?: number;
  audioPath?: string;
  duration?: number;
  startOffset?: number;
  shotCount?: number;
};

export type FacelessTimeline = {
  totalDuration: number;
  shots: FacelessShot[];
  chapters?: FacelessChapter[];
  youtubeTimestamps?: string;
  audioPath?: string;
  subtitlePath?: string;
  resolution: {
    width: number;
    height: number;
  };
  fps: number;
};

export type FacelessVideoTone = 'documentary' | 'investigative' | 'storytelling' | 'dramatic';

export type FacelessVideoInput = {
  title: string;
  topic?: string;
  script: string;
  chapters?: FacelessChapter[];
  youtubeTimestamps?: string;
  audioFile?: string;
  images: string[];
  targetDuration?: number;
  targetDurationMinutes?: number;
  tone?: FacelessVideoTone;
  scriptApproved?: boolean;
  voiceProvider?: 'edge-tts' | 'openai' | 'custom';
  voiceId?: string;
  voiceSpeed?: number;
  voiceAudioUrl?: string;
  resolution: '1080p' | '720p';
  aspectRatio: '16:9' | '9:16';
  currentStep: number;
  furthestStep: number;
  currentStage: string | null;
};

/**
 * Strips bracket cues like [Visual: aerial shot...] so narrators do not read visual cues aloud.
 */
export function cleanChapterNarrationText(text: string): string {
  if (!text || !text.trim()) return '';

  return text
    .replace(/\[(?:Visual|Hook|Intro|Chapter|Sound|Music|B-Roll|Graphic|Footage)[^\]]*\]/gi, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^---+$/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Cleans a markdown header string into a clean chapter title.
 * e.g. "## [HOOK & INTRO]" -> "Hook & Intro"
 */
export function cleanChapterTitle(rawHeader: string): string {
  let cleaned = rawHeader
    .replace(/^#+\s*/, '')
    .trim();

  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (cleaned.length > 3 && cleaned === cleaned.toUpperCase()) {
    cleaned = toTitleCase(cleaned);
  }

  return cleaned || 'Untitled Chapter';
}

function toTitleCase(str: string): string {
  return str.replace(/\w\S*/g, txt => {
    if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X|UK|US|USA|AI|TV|CEO|GDP)$/i.test(txt)) {
      return txt.toUpperCase();
    }
    return txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase();
  });
}

/**
 * Formats seconds into MM:SS or HH:MM:SS format (required for YouTube Timestamps).
 */
export function formatYoutubeTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hrs > 0) {
    const hh = String(hrs).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Parses documentary script markdown into structured chapters.
 */
export function parseChaptersFromScript(scriptText: string): FacelessChapter[] {
  if (!scriptText || !scriptText.trim()) {
    return [];
  }

  const lines = scriptText.split(/\r?\n/);
  const rawSections: Array<{ header: string; bodyLines: string[] }> = [];

  let currentHeader = '';
  let currentBody: string[] = [];
  let foundFirstHeader = false;

  for (const line of lines) {
    const isChapterHeader = /^##+\s+/.test(line.trim());

    if (isChapterHeader) {
      if (foundFirstHeader) {
        rawSections.push({
          header: currentHeader,
          bodyLines: currentBody
        });
      } else if (currentBody.some(l => l.trim())) {
        rawSections.push({
          header: '## Introduction',
          bodyLines: currentBody
        });
      }
      currentHeader = line.trim();
      currentBody = [];
      foundFirstHeader = true;
    } else {
      if (!foundFirstHeader && /^#\s+/.test(line.trim())) {
        continue;
      }
      currentBody.push(line);
    }
  }

  if (foundFirstHeader) {
    rawSections.push({
      header: currentHeader,
      bodyLines: currentBody
    });
  } else if (currentBody.some(l => l.trim())) {
    rawSections.push({
      header: '## Full Narration',
      bodyLines: currentBody
    });
  }

  const chapters: FacelessChapter[] = rawSections.map((section, idx) => {
    const title = cleanChapterTitle(section.header);
    const text = section.bodyLines.join('\n').trim();
    const cleanText = cleanChapterNarrationText(text);
    const wordCount = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;

    return {
      id: `chapter-${idx}`,
      order: idx,
      title,
      text,
      wordCount,
      duration: Math.max(5, Math.round(wordCount / 2.33))
    };
  });

  let currentOffset = 0;
  for (const chap of chapters) {
    chap.startOffset = currentOffset;
    currentOffset += chap.duration ?? 0;
  }

  return chapters;
}

/**
 * Generates ready-to-paste YouTube chapter timestamps from chapters.
 * Guarantees that the first timestamp starts at 00:00.
 */
export function generateYoutubeTimestamps(chapters: FacelessChapter[]): string {
  if (chapters.length === 0) return '';

  return chapters.map((chap, idx) => {
    const timestamp = idx === 0 ? '00:00' : formatYoutubeTimestamp(chap.startOffset ?? 0);
    return `${timestamp} ${chap.title}`;
  }).join('\n');
}
