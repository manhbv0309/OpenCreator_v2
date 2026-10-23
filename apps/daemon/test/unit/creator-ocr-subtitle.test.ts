import { describe, expect, it } from 'vitest';
import {
  clusterOcrFrames,
  buildSrtFromCues,
  textSimilarity,
  levenshteinDistance
} from '../../src/creator/ocr/subtitle-clustering.js';
import { parseSrt } from '../../src/creator/validators/srt.js';

describe('OCR subtitle clustering and SRT generation', () => {
  it('computes Levenshtein distance and text similarity correctly', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
    expect(levenshteinDistance('hello', 'helo')).toBe(1);
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
    expect(textSimilarity('hello world', 'hello world!')).toBeGreaterThan(0.9);
    expect(textSimilarity('Xin chào', 'Tạm biệt')).toBeLessThan(0.4);
  });

  it('clusters consecutive frames with identical or similar text', () => {
    const frames = [
      { timeSec: 1.0, text: 'Welcome to this video' },
      { timeSec: 1.5, text: 'Welcome to this video' },
      { timeSec: 2.0, text: 'Welcome to this video.' }, // slight punctuation variation
      { timeSec: 2.5, text: 'Welcome to this video' },
      // gap
      { timeSec: 4.0, text: 'In today tutorial' },
      { timeSec: 4.5, text: 'In today tutorial' },
      { timeSec: 5.0, text: 'In today tutorial' }
    ];

    const cues = clusterOcrFrames(frames, { frameIntervalSec: 0.5 });
    expect(cues).toHaveLength(2);

    expect(cues[0]!.index).toBe(1);
    expect(cues[0]!.text).toContain('Welcome to this video');
    expect(cues[0]!.start).toBe('00:00:01,000');
    expect(cues[0]!.end).toBe('00:00:03,000');

    expect(cues[1]!.index).toBe(2);
    expect(cues[1]!.text).toBe('In today tutorial');
    expect(cues[1]!.start).toBe('00:00:04,000');
    expect(cues[1]!.end).toBe('00:00:05,500');
  });

  it('generates valid parseable SRT format from clustered cues', () => {
    const frames = [
      { timeSec: 0.5, text: 'Chào mừng các bạn' },
      { timeSec: 1.0, text: 'Chào mừng các bạn' },
      { timeSec: 2.0, text: 'Đến với kênh video' },
      { timeSec: 2.5, text: 'Đến với kênh video' }
    ];

    const cues = clusterOcrFrames(frames);
    const srt = buildSrtFromCues(cues);

    expect(srt).toContain('1\n00:00:00,500 -->');
    expect(srt).toContain('Chào mừng các bạn');
    expect(srt).toContain('2\n00:00:02,000 -->');
    expect(srt).toContain('Đến với kênh video');

    const parsed = parseSrt(srt);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.text).toBe('Chào mừng các bạn');
    expect(parsed[1]!.text).toBe('Đến với kênh video');
  });

  it('filters out empty or noise frames', () => {
    const frames = [
      { timeSec: 0.5, text: '' },
      { timeSec: 1.0, text: '   ' },
      { timeSec: 1.5, text: '.' },
      { timeSec: 3.0, text: 'Valid subtitle line' },
      { timeSec: 3.5, text: 'Valid subtitle line' }
    ];

    const cues = clusterOcrFrames(frames);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('Valid subtitle line');
  });
});
