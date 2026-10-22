import { describe, expect, it } from 'vitest';
import { createFacelessVideoTemplate } from '../../src/creator/templates/faceless-video.js';
import { buildFacelessTimeline } from '../../src/creator/faceless/timeline-builder.js';
import { buildZoompanFilter } from '../../src/creator/faceless/ffmpeg-renderer.js';
import { generateDocumentaryScript } from '../../src/creator/faceless/script-generator.js';

describe('faceless video template & engine', () => {
  it('validates template structure and stages', () => {
    const template = createFacelessVideoTemplate();
    expect(template.id).toBe('faceless-video');
    expect(template.version).toBe(1);
    expect(template.stages.map(s => s.id)).toEqual(['script', 'timeline', 'render']);

    const defaultInput = template.inputSchema.parse({}) as Record<string, unknown>;
    expect(defaultInput.resolution).toBe('1080p');
    expect(defaultInput.aspectRatio).toBe('16:9');
    expect(defaultInput.targetDurationMinutes).toBe(10);
  });

  it('generates structured documentary script with chapters and visual cues', async () => {
    const script = await generateDocumentaryScript({
      topic: 'Why Japan Has So Many Empty Houses',
      targetDurationMinutes: 10
    });

    expect(script).toContain('# Why Japan Has Over 9 Million Abandoned Houses');
    expect(script).toContain('## [HOOK & INTRO]');
    expect(script).toContain('## [CHAPTER 1:');
    expect(script).toContain('[Visual:');
    expect(script.split(/\s+/).length).toBeGreaterThan(500);
  });

  it('builds timeline and srt correctly from script and images', async () => {
    const script = 'Why Japan has so many empty houses. Millions of homes sit abandoned across the country.';
    const images = ['/path/to/img1.jpg', '/path/to/img2.jpg'];
    const { timeline, srtContent } = await buildFacelessTimeline({
      script,
      images,
      targetDuration: 20
    });

    expect(timeline.totalDuration).toBe(20);
    expect(timeline.shots.length).toBe(4); // 20s / 5s = 4 shots
    expect(timeline.shots[0]?.duration).toBe(5);
    expect(timeline.shots[0]?.motion).toBe('zoom-in');
    expect(timeline.shots[1]?.motion).toBe('pan-left');
    expect(timeline.shots[2]?.motion).toBe('zoom-out');
    expect(timeline.shots[3]?.motion).toBe('pan-right');

    expect(srtContent).toContain('Why Japan has so many empty houses.');
    expect(srtContent).toContain('Millions of homes sit abandoned across the country.');
    expect(srtContent).toContain('00:00:00,000 -->');
  });

  it('generates valid zoompan filter strings', () => {
    const zoomInFilter = buildZoompanFilter('zoom-in', 150, 1920, 1080, 30);
    expect(zoomInFilter).toContain('zoompan=z=\'min(zoom+0.0015,1.2)\'');
    expect(zoomInFilter).toContain('s=1920x1080:fps=30');

    const panLeftFilter = buildZoompanFilter('pan-left', 150, 1920, 1080, 30);
    expect(panLeftFilter).toContain('z=1.12');
    expect(panLeftFilter).toContain('s=1920x1080:fps=30');
  });

  it('parses chapters, strips visual cues, and computes YouTube timestamps', async () => {
    const {
      parseChaptersFromScript,
      cleanChapterNarrationText,
      cleanChapterTitle,
      formatYoutubeTimestamp,
      generateYoutubeTimestamps
    } = await import('../../src/creator/faceless/chapter-parser.js');

    expect(cleanChapterTitle('## [HOOK & INTRO]')).toBe('Hook & Intro');
    expect(cleanChapterTitle('## [CHAPTER 1: THE GHOST VILLAGES]')).toBe('Chapter 1: The Ghost Villages');

    const rawChapterText = '[Visual: drone shot over empty village] Across rural Japan, millions of homes sit completely empty.';
    expect(cleanChapterNarrationText(rawChapterText)).toBe('Across rural Japan, millions of homes sit completely empty.');

    const sampleScript = [
      '# Why Japan Has So Many Empty Houses',
      '',
      '## [HOOK & INTRO]',
      '[Visual: dramatic opening] Across rural Japan, millions of homes sit completely empty.',
      '',
      '## [CHAPTER 1: THE PHENOMENON]',
      '[Visual: old houses] In Japanese, these properties are known as akiya.',
      '',
      '## [CONCLUSION & OUTRO]',
      'Thank you for watching, please subscribe.'
    ].join('\n');

    const chapters = parseChaptersFromScript(sampleScript);
    expect(chapters.length).toBe(3);
    expect(chapters[0]?.title).toBe('Hook & Intro');
    expect(chapters[1]?.title).toBe('Chapter 1: The Phenomenon');
    expect(chapters[2]?.title).toBe('Conclusion & Outro');
    expect(chapters[0]?.startOffset).toBe(0);

    // YouTube timestamp formatting
    expect(formatYoutubeTimestamp(0)).toBe('00:00');
    expect(formatYoutubeTimestamp(75)).toBe('01:15');
    expect(formatYoutubeTimestamp(3665)).toBe('01:01:05');

    const timestamps = generateYoutubeTimestamps(chapters);
    expect(timestamps).toContain('00:00 Hook & Intro');
    expect(timestamps.split('\n')[0]).toBe('00:00 Hook & Intro');
  });

  it('builds chapter-synchronized timeline with chapterId on shots', async () => {
    const chapters = [
      {
        id: 'chapter-0',
        order: 0,
        title: 'Hook & Intro',
        text: 'This is the introduction scene hook.',
        duration: 10
      },
      {
        id: 'chapter-1',
        order: 1,
        title: 'Chapter 1: The Roots',
        text: 'This is the body explaining the root causes.',
        duration: 15
      }
    ];

    const { timeline } = await buildFacelessTimeline({
      script: 'This is the introduction scene hook. This is the body explaining the root causes.',
      chapters,
      images: ['/img1.jpg']
    });

    expect(timeline.totalDuration).toBe(25);
    expect(timeline.chapters?.length).toBe(2);
    expect(timeline.youtubeTimestamps).toContain('00:00 Hook & Intro');
    expect(timeline.youtubeTimestamps).toContain('00:10 Chapter 1: The Roots');

    // Check that shots carry chapterId
    expect(timeline.shots[0]?.chapterId).toBe('chapter-0');
    expect(timeline.shots[timeline.shots.length - 1]?.chapterId).toBe('chapter-1');
  });
});
