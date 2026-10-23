import { formatSrtTimestamp } from '../validators/srt.js';

export type RawOcrFrame = {
  timeSec: number;
  text: string;
};

export type ClusteredSubtitleCue = {
  index: number;
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  text: string;
};

export type ClusterOptions = {
  frameIntervalSec?: number;
  minDurationMs?: number;
  similarityThreshold?: number;
};

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost
      );
    }
  }

  return d[m]![n]!;
}

export function textSimilarity(a: string, b: string): number {
  const normA = cleanOcrText(a);
  const normB = cleanOcrText(b);
  if (normA === normB) return 1;
  if (!normA || !normB) return 0;
  const longer = normA.length > normB.length ? normA : normB;
  const shorter = normA.length > normB.length ? normB : normA;
  if (longer.length === 0) return 1;
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

export function cleanOcrText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[~`^|\\_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSemanticOcrText(text: string): boolean {
  const cleaned = cleanOcrText(text);
  if (!cleaned) return false;
  const noSpace = cleaned.replace(/\s+/g, '');
  if (noSpace.length < 2) return false;
  // Count meaningful letters / CJK (Unicode category Letter and CJK Unified Ideographs)
  const letters = noSpace.replace(/[^\p{L}\u3400-\u9fff\u3040-\u30ff]/gu, '');
  if (letters.length < 2) return false;
  const meaningful = noSpace.replace(/[^\p{L}\p{N}\u3400-\u9fff\u3040-\u30ff]/gu, '');
  if (meaningful.length / noSpace.length < 0.5) return false;
  return true;
}

export function clusterOcrFrames(
  frames: RawOcrFrame[],
  options: ClusterOptions = {}
): ClusteredSubtitleCue[] {
  const frameIntervalSec = options.frameIntervalSec ?? 0.5;
  const minDurationMs = Math.min(options.minDurationMs ?? 400, frameIntervalSec * 1000);
  const similarityThreshold = options.similarityThreshold ?? 0.55;

  const validFrames = frames
    .map(f => ({ ...f, text: cleanOcrText(f.text) }))
    .filter(f => isSemanticOcrText(f.text));

  if (validFrames.length === 0) return [];

  const rawCues: Array<{ startMs: number; endMs: number; text: string }> = [];
  let current: { startMs: number; endMs: number; text: string } | null = null;

  for (const frame of validFrames) {
    const frameStartMs = Math.round(frame.timeSec * 1000);
    const frameEndMs = Math.round((frame.timeSec + frameIntervalSec) * 1000);

    if (current === null) {
      current = {
        startMs: frameStartMs,
        endMs: frameEndMs,
        text: frame.text
      };
      continue;
    }

    const similarity = textSimilarity(current.text, frame.text);
    const gap = frameStartMs - current.endMs;

    // Same or continuing subtitle if text is similar and gap is small (<= 800ms)
    if (similarity >= similarityThreshold && gap <= 800) {
      current.endMs = Math.max(current.endMs, frameEndMs);
      if (frame.text.length > current.text.length) {
        current.text = frame.text;
      }
    } else {
      if (current.endMs - current.startMs >= minDurationMs) {
        rawCues.push({ ...current });
      }
      current = {
        startMs: frameStartMs,
        endMs: frameEndMs,
        text: frame.text
      };
    }
  }

  if (current !== null && current.endMs - current.startMs >= minDurationMs) {
    rawCues.push(current);
  }

  // Ensure non-overlapping and strictly increasing cues
  const finalCues: ClusteredSubtitleCue[] = [];
  let lastEndMs = 0;

  for (let i = 0; i < rawCues.length; i++) {
    const cue = rawCues[i]!;
    const startMs = Math.max(cue.startMs, lastEndMs);
    const endMs = Math.max(startMs + minDurationMs, cue.endMs);
    lastEndMs = endMs;

    finalCues.push({
      index: finalCues.length + 1,
      startMs,
      endMs,
      start: formatSrtTimestamp(startMs),
      end: formatSrtTimestamp(endMs),
      text: cue.text
    });
  }

  return finalCues;
}

export function buildSrtFromCues(cues: ClusteredSubtitleCue[]): string {
  if (cues.length === 0) return '';
  return cues
    .map(cue => `${cue.index}\n${cue.start} --> ${cue.end}\n${cue.text}\n`)
    .join('\n');
}
