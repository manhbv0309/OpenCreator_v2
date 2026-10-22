import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Filter,
  Layers,
  ListMusic,
  LoaderCircle,
  Music,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Upload,
  Video,
  Volume2,
  Wand2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  FacelessChapter,
  FacelessShot,
  FacelessShotMotion,
  FacelessTimeline,
  FacelessVideoTone
} from '@opencreator/protocol';
import {
  cleanChapterNarrationText,
  formatYoutubeTimestamp,
  generateYoutubeTimestamps,
  parseChaptersFromScript
} from '@opencreator/protocol';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import CreatorToolShell from './CreatorToolShell.js';
import {
  createCreatorArtifactObjectUrl,
  useOptionalCreatorSession
} from './creator-session-store.js';
import { facelessVideoPanelAdapter } from './creator-panel-adapters.js';
import './faceless-video-workspace.css';

export default function FacelessVideoWorkspace(props: {
  onBack(): void;
  promptHint?: string;
}) {
  const l = useLocalizedCopy();
  const session = useOptionalCreatorSession();

  const [topic, setTopic] = useState<string>(() => (typeof session?.state.topic === 'string' ? session.state.topic : (props.promptHint || 'Why Japan Has So Many Empty Houses')));
  const [title, setTitle] = useState<string>(() => (typeof session?.state.title === 'string' ? session.state.title : 'Why Japan Has So Many Empty Houses'));
  const [targetDurationMinutes, setTargetDurationMinutes] = useState<number>(() => (typeof session?.state.targetDurationMinutes === 'number' ? session.state.targetDurationMinutes : 10));
  const [tone, setTone] = useState<FacelessVideoTone>(() => (typeof session?.state.tone === 'string' ? session.state.tone as FacelessVideoTone : 'documentary'));
  const [scriptApproved, setScriptApproved] = useState<boolean>(() => Boolean(session?.state.scriptApproved));
  const [script, setScript] = useState<string>(() => (typeof session?.state.script === 'string' ? session.state.script : ''));
  const [chapters, setChapters] = useState<FacelessChapter[]>(() => {
    if (Array.isArray(session?.state.chapters) && session.state.chapters.length > 0) {
      return session.state.chapters as FacelessChapter[];
    }
    return [];
  });
  const [chapterAudioUrls, setChapterAudioUrls] = useState<Record<string, string>>({});
  const [audioFile, setAudioFile] = useState<string>(() => (typeof session?.state.audioFile === 'string' ? session.state.audioFile : ''));
  const [imagesText, setImagesText] = useState<string>(() => (Array.isArray(session?.state.images) ? (session.state.images as string[]).join('\n') : ''));
  const [resolution, setResolution] = useState<'1080p' | '720p'>('1080p');
  const [currentStep, setCurrentStep] = useState<number>(() => {
    if (typeof session?.state.currentStep === 'number') return session.state.currentStep;
    return 0;
  });
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [timelineData, setTimelineData] = useState<FacelessTimeline | null>(null);
  const [shotPage, setShotPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);
  const [shotSearch, setShotSearch] = useState<string>('');
  const [selectedShotIndex, setSelectedShotIndex] = useState<number | null>(null);
  const [selectedChapterFilter, setSelectedChapterFilter] = useState<string>('all');
  const [copiedTimestamps, setCopiedTimestamps] = useState<boolean>(false);

  // Clean up chapter audio object URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(chapterAudioUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [chapterAudioUrls]);

  const images = useMemo(
    () => imagesText.split('\n').map(s => s.trim()).filter(Boolean),
    [imagesText]
  );

  const wordCount = useMemo(() => {
    return script.trim() ? script.trim().split(/\s+/).filter(Boolean).length : 0;
  }, [script]);

  const estimatedReadMinutes = useMemo(() => {
    if (wordCount === 0) return targetDurationMinutes;
    return Math.max(1, Math.round((wordCount / 140) * 10) / 10);
  }, [wordCount, targetDurationMinutes]);

  const totalChapterDuration = useMemo(() => {
    return chapters.reduce((sum, c) => sum + (c.duration ?? 0), 0);
  }, [chapters]);

  const youtubeTimestamps = useMemo(() => {
    return generateYoutubeTimestamps(chapters);
  }, [chapters]);

  // Auto-parse chapters from script if chapters list is empty
  useEffect(() => {
    if (script.trim() && chapters.length === 0) {
      const parsed = parseChaptersFromScript(script);
      setChapters(parsed);
    }
  }, [script, chapters.length]);

  const scriptStage = session?.job.stages.find(s => s.stageId === 'script');
  const timelineStage = session?.job.stages.find(s => s.stageId === 'timeline');
  const renderStage = session?.job.stages.find(s => s.stageId === 'render');

  const isGeneratingScript = scriptStage?.status === 'running' || scriptStage?.status === 'queued';
  const isGeneratingTimeline = timelineStage?.status === 'running' || timelineStage?.status === 'queued';
  const isRendering = renderStage?.status === 'running' || renderStage?.status === 'queued';
  const renderFailed = renderStage?.status === 'failed';
  const renderErrorMessage = renderStage?.errorMessage || (renderFailed ? l('视频渲染遇到错误，请重试或检查设置。', 'Video rendering encountered an error. Please retry or check settings.') : '');
  const busy = isGeneratingScript || isGeneratingTimeline || isRendering;

  const renderProgress = renderStage?.progress;
  const renderPercent = typeof renderProgress?.percent === 'number'
    ? renderProgress.percent
    : (isRendering ? 10 : 0);
  const renderPhaseText = typeof renderProgress?.phase === 'string'
    ? facelessVideoPanelAdapter.phaseLabel(renderProgress.phase, l)
    : (isRendering ? l('正在准备渲染…', 'Preparing render…') : '');
  const renderCountText = typeof renderProgress?.total === 'number' && renderProgress.total > 0
    ? `(${typeof renderProgress.completed === 'number' ? renderProgress.completed : 0} / ${renderProgress.total} ${l('镜头', 'shots')})`
    : '';

  const scriptArtifact = session?.job.artifacts.find(a => a.kind === 'faceless_script' && a.status === 'completed');
  const timelineArtifact = session?.job.artifacts.find(a => a.kind === 'faceless_timeline' && a.status === 'completed');
  const videoArtifact = session?.job.artifacts.find(a => a.kind === 'faceless_video' && a.status === 'completed');

  const scriptArtifactId = scriptArtifact?.id;
  const timelineArtifactId = timelineArtifact?.id;
  const videoArtifactId = videoArtifact?.id;
  const sessionOpenArtifact = session?.openArtifact;
  const sessionOpenArtifactJson = session?.openArtifactJson;

  // Load generated script when artifact completes
  useEffect(() => {
    if (!scriptArtifactId || !sessionOpenArtifact) return;
    let alive = true;
    void sessionOpenArtifact(scriptArtifactId)
      .then(res => res.text())
      .then(text => {
        if (alive && text.trim()) {
          setScript(text);
          const parsed = parseChaptersFromScript(text);
          setChapters(parsed);
        }
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [scriptArtifactId, sessionOpenArtifact]);

  // Load timeline data when artifact is available
  useEffect(() => {
    if (!timelineArtifactId || !sessionOpenArtifactJson) return;
    let alive = true;
    void sessionOpenArtifactJson<FacelessTimeline>(timelineArtifactId)
      .then(data => {
        if (alive && data) {
          setTimelineData(data);
          if (data.chapters && data.chapters.length > 0) {
            setChapters(data.chapters);
          }
        }
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [timelineArtifactId, sessionOpenArtifactJson]);

  // Load video URL when artifact is available (depends ONLY on videoArtifactId to prevent player flickering)
  useEffect(() => {
    if (!videoArtifactId || !sessionOpenArtifact) {
      setVideoUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
      return;
    }
    let alive = true;
    let cleanupUrl = '';
    void createCreatorArtifactObjectUrl(session!, videoArtifactId, 'load_video', 'Failed to load video')
      .then(url => {
        if (alive) {
          cleanupUrl = url;
          setVideoUrl(url);
          setCurrentStep(4);
        } else {
          URL.revokeObjectURL(url);
        }
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      if (cleanupUrl) URL.revokeObjectURL(cleanupUrl);
    };
  }, [videoArtifactId, sessionOpenArtifact]);

  const syncDraft = async (stepOverride?: number) => {
    if (!session) return;
    const stepToSave = typeof stepOverride === 'number' ? stepOverride : currentStep;
    session.updateDraft({
      title: title || topic,
      topic,
      targetDurationMinutes,
      tone,
      scriptApproved,
      script,
      chapters,
      youtubeTimestamps,
      audioFile: audioFile.trim() || null,
      images,
      resolution,
      currentStep: stepToSave,
      furthestStep: Math.max(stepToSave, Number(session.state.furthestStep) || 0)
    }, { semantic: true });
    await session.flush();
  };

  const shotTimestamps = useMemo(() => {
    if (!timelineData?.shots) return [];
    let acc = 0;
    return timelineData.shots.map(shot => {
      const start = acc;
      acc += shot.duration;
      return { start, end: acc };
    });
  }, [timelineData?.shots]);

  const filteredShots = useMemo(() => {
    if (!timelineData?.shots) return [];
    let result = timelineData.shots;
    if (selectedChapterFilter !== 'all') {
      result = result.filter(s => s.chapterId === selectedChapterFilter);
    }
    if (!shotSearch.trim()) return result;
    const query = shotSearch.toLowerCase();
    return result.filter((s, idx) =>
      `#${idx + 1}`.includes(query) ||
      (s.text && s.text.toLowerCase().includes(query)) ||
      s.motion.toLowerCase().includes(query)
    );
  }, [timelineData?.shots, selectedChapterFilter, shotSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredShots.length / (pageSize || filteredShots.length || 1)));
  const currentPage = Math.min(Math.max(1, shotPage), totalPages);

  const paginatedShots = useMemo(() => {
    if (pageSize === 0) return filteredShots;
    const start = (currentPage - 1) * pageSize;
    return filteredShots.slice(start, start + pageSize);
  }, [filteredShots, currentPage, pageSize]);

  const formatTimestamp = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const handleUpdateShot = (index: number, updated: Partial<FacelessShot>) => {
    if (!timelineData) return;
    const newShots = [...timelineData.shots];
    const prevShot = newShots[index];
    if (!prevShot) return;
    newShots[index] = { ...prevShot, ...updated };
    const newTotalDuration = Math.round(newShots.reduce((sum, s) => sum + s.duration, 0) * 100) / 100;
    const newTimeline: FacelessTimeline = {
      ...timelineData,
      shots: newShots,
      totalDuration: newTotalDuration
    };
    setTimelineData(newTimeline);
  };

  const handleUpdateChapter = (chapId: string, updated: Partial<FacelessChapter>) => {
    setChapters(prev => {
      const next = prev.map(c => (c.id === chapId ? { ...c, ...updated } : c));
      let acc = 0;
      return next.map(c => {
        const startOffset = acc;
        acc += c.duration ?? 0;
        return { ...c, startOffset };
      });
    });
  };

  const handleChapterFileUpload = (chapId: string, file: File) => {
    const url = URL.createObjectURL(file);
    setChapterAudioUrls(prev => {
      if (prev[chapId]) URL.revokeObjectURL(prev[chapId]);
      return { ...prev, [chapId]: url };
    });
    handleUpdateChapter(chapId, { audioPath: file.name });
  };

  const handleReparseChapters = () => {
    if (!script.trim()) return;
    const parsed = parseChaptersFromScript(script);
    setChapters(parsed);
  };

  const handleCopyTimestamps = () => {
    if (!youtubeTimestamps) return;
    void navigator.clipboard.writeText(youtubeTimestamps);
    setCopiedTimestamps(true);
    setTimeout(() => setCopiedTimestamps(false), 2000);
  };

  const handleGenerateScript = async () => {
    try {
      await syncDraft(1);
      await session?.applyAction({
        action: 'run-stage',
        input: { stageId: 'script' }
      });
      setCurrentStep(1);
    } catch (e) {
      console.error('Failed to run script stage:', e);
    }
  };

  const handleApproveScript = async () => {
    try {
      setScriptApproved(true);
      let currentChapters = chapters;
      if (currentChapters.length === 0 && script.trim()) {
        currentChapters = parseChaptersFromScript(script);
        setChapters(currentChapters);
      }
      if (session) {
        session.updateDraft({
          scriptApproved: true,
          script,
          chapters: currentChapters,
          youtubeTimestamps: generateYoutubeTimestamps(currentChapters),
          currentStep: 2,
          furthestStep: Math.max(2, Number(session.state.furthestStep) || 0)
        }, { semantic: true });
        await session.flush();
      }
      setCurrentStep(2);
    } catch (e) {
      console.error('Failed to approve script and proceed to chapters:', e);
    }
  };

  const handleConfirmChaptersAndGenerateTimeline = async () => {
    try {
      if (session) {
        session.updateDraft({
          chapters,
          youtubeTimestamps,
          audioFile: audioFile.trim() || null,
          currentStep: 3,
          furthestStep: Math.max(3, Number(session.state.furthestStep) || 0)
        }, { semantic: true });
        await session.flush();
      }
      setCurrentStep(3);
      await session?.applyAction({
        action: 'run-stage',
        input: { stageId: 'timeline' }
      });
    } catch (e) {
      console.error('Failed to confirm chapters and generate timeline:', e);
    }
  };

  const handleRenderVideo = async () => {
    try {
      if (session) {
        session.updateDraft({
          title: title || topic,
          topic,
          targetDurationMinutes,
          tone,
          scriptApproved,
          script,
          chapters,
          youtubeTimestamps,
          audioFile: audioFile.trim() || null,
          images,
          resolution,
          currentStep: 4,
          furthestStep: Math.max(4, Number(session.state.furthestStep) || 0)
        }, { semantic: true });
        await session.flush();
      }
      setCurrentStep(4);
      await session?.applyAction({
        action: 'run-stage',
        input: { stageId: 'render' }
      });
    } catch (e) {
      console.error('Failed to render video:', e);
    }
  };

  const handleRetryRender = async () => {
    try {
      setCurrentStep(4);
      await session?.applyAction({
        action: 'retry-stage',
        input: { stageId: 'render' }
      });
    } catch (e) {
      console.error('Failed to retry render video:', e);
    }
  };

  const handleDownload = () => {
    if (!videoUrl) return;
    const a = document.createElement('a');
    a.href = videoUrl;
    a.download = `${(title || topic).replace(/\s+/g, '_')}_1080p.mp4`;
    a.click();
  };

  return (
    <CreatorToolShell
      title={l('Faceless Video 制作', 'Faceless Video Studio')}
      subtitle={l('输入主题 Prompt，AI 自动研究生成脚本，分章节配音并生成 YouTube 时间戳，一键渲染 10-15 分钟纪录片', 'Enter a topic prompt, AI researches script, manage chapter audios & YouTube timestamps, render 10-15 min documentary')}
      context={l(`主题: ${topic || title}`, `Topic: ${topic || title}`)}
      placeholder={l('描述需要调整的章节、分镜、语速、画面或文案…', 'Describe changes to chapters, shots, timing, visuals, or script…')}
      suggestions={[
        l('编写更加戏剧化的开场 Hook', 'Write a more dramatic opening hook'),
        l('调整视频时长为 15 分钟', 'Adjust duration to 15 minutes'),
        l('使用缓慢放大镜头效果', 'Use gentle zoom-in effect'),
        l('重新生成分镜时间线', 'Regenerate timeline')
      ]}
      onBack={props.onBack}
    >
      <div className="faceless-workspace">
        {/* Stepper Navigation */}
        <nav className="faceless-stepper" aria-label="Workflow Steps">
          <button
            type="button"
            className={`faceless-step-btn ${currentStep === 0 ? 'active' : ''} ${script ? 'completed' : ''}`}
            onClick={() => setCurrentStep(0)}
          >
            <Sparkles size={15} />
            1. {l('主题 Prompt', 'Prompt & Setup')}
          </button>
          <button
            type="button"
            className={`faceless-step-btn ${currentStep === 1 ? 'active' : ''} ${scriptApproved ? 'completed' : ''}`}
            onClick={() => setCurrentStep(1)}
          >
            <BookOpen size={15} />
            2. {l('审核文案', 'Script Review')} {script ? `(${wordCount}w)` : ''}
          </button>
          <button
            type="button"
            className={`faceless-step-btn ${currentStep === 2 ? 'active' : ''} ${chapters.length > 0 ? 'completed' : ''}`}
            onClick={() => setCurrentStep(2)}
            disabled={!script}
          >
            <Music size={15} />
            3. {l('章节与配音', 'Chapters & Audio')} {chapters.length > 0 ? `(${chapters.length})` : ''}
          </button>
          <button
            type="button"
            className={`faceless-step-btn ${currentStep === 3 ? 'active' : ''} ${timelineData ? 'completed' : ''}`}
            onClick={() => setCurrentStep(3)}
            disabled={!script}
          >
            <Layers size={15} />
            4. {l('分镜时间线', 'Shot Timeline')}
          </button>
          <button
            type="button"
            className={`faceless-step-btn ${currentStep === 4 ? 'active' : ''} ${videoUrl ? 'completed' : ''}`}
            onClick={() => setCurrentStep(4)}
            disabled={!timelineData && !videoUrl}
          >
            <Video size={15} />
            5. {l('成片输出', 'Final Video')}
          </button>
        </nav>

        {/* Step 1: Prompt & Duration Setup */}
        {currentStep === 0 && (
          <section className="faceless-card" aria-label="Step 1: Topic Prompt">
            <div className="faceless-card-header">
              <h2><Wand2 size={18} /> {l('第一步：输入主题 Prompt 与设定', 'Step 1: Topic Prompt & Settings')}</h2>
            </div>

            <div className="faceless-form-group">
              <label>{l('视频主题 / 提问 Prompt (Topic / Question)', 'Video Topic / Question Prompt')}</label>
              <input
                className="faceless-input"
                value={topic}
                disabled={busy}
                onChange={e => {
                  setTopic(e.target.value);
                  setTitle(e.target.value);
                }}
                placeholder="e.g. Why Japan Has So Many Empty Houses"
              />
            </div>

            <div className="faceless-row">
              <div className="faceless-form-group">
                <label>{l('目标成片时长 (Target Duration)', 'Target Video Duration')}</label>
                <select
                  className="faceless-input"
                  value={targetDurationMinutes}
                  disabled={busy}
                  onChange={e => setTargetDurationMinutes(Number(e.target.value))}
                >
                  <option value={10}>10 {l('分钟 (~1,500 词，标准纪录片)', 'Minutes (~1,500 words, Standard Documentary)')}</option>
                  <option value={12}>12 {l('分钟 (~1,800 词，深度剖析)', 'Minutes (~1,800 words, In-depth Deep Dive)')}</option>
                  <option value={15}>15 {l('分钟 (~2,250 词，长篇大作)', 'Minutes (~2,250 words, Long-form Documentary)')}</option>
                  <option value={5}>5 {l('分钟 (~750 词，精炼短片)', 'Minutes (~750 words, Concise Overview)')}</option>
                </select>
              </div>

              <div className="faceless-form-group">
                <label>{l('叙事基调 / 风格 (Tone)', 'Narrative Tone')}</label>
                <select
                  className="faceless-input"
                  value={tone}
                  disabled={busy}
                  onChange={e => setTone(e.target.value as FacelessVideoTone)}
                >
                  <option value="documentary">{l('Documentary (客观、权威、深入)', 'Documentary (Objective & Insightful)')}</option>
                  <option value="investigative">{l('Investigative (调查、揭秘、悬念)', 'Investigative (Mystery & Revelations)')}</option>
                  <option value="storytelling">{l('Storytelling (沉浸、人文、叙事)', 'Storytelling (Cinematic & Engaging)')}</option>
                  <option value="dramatic">{l('Dramatic (快节奏、高潮迭起)', 'Dramatic (High Stakes & Urgency)')}</option>
                </select>
              </div>

              <div className="faceless-form-group">
                <label>{l('输出画质 (Resolution)', 'Output Resolution')}</label>
                <select
                  className="faceless-input"
                  value={resolution}
                  disabled={busy}
                  onChange={e => setResolution(e.target.value as '1080p' | '720p')}
                >
                  <option value="1080p">1080p Full HD (1920x1080)</option>
                  <option value="720p">720p HD (1280x720)</option>
                </select>
              </div>
            </div>

            <div className="faceless-actions">
              <button
                className="faceless-primary-button"
                type="button"
                disabled={busy || !topic.trim()}
                onClick={handleGenerateScript}
              >
                {isGeneratingScript ? (
                  <LoaderCircle className="animate-spin" size={16} />
                ) : (
                  <Sparkles size={16} />
                )}
                {isGeneratingScript ? l('AI 正在研究资料并撰写文案…', 'AI Researching & Drafting Script…') : l('AI 生成深度纪录片文案', 'Generate Script with AI')}
              </button>

              {script ? (
                <button
                  className="faceless-secondary-button"
                  type="button"
                  onClick={() => setCurrentStep(1)}
                >
                  <FileText size={16} />
                  {l('查看已有文案', 'View Current Script')} ({wordCount} {l('词', 'words')})
                </button>
              ) : null}
            </div>
          </section>
        )}

        {/* Step 2: Script Review & Approval */}
        {currentStep === 1 && (
          <section className="faceless-card" aria-label="Step 2: Script Review & Approval">
            <div className="faceless-card-header">
              <h2><BookOpen size={18} /> {l('第二步：审核并确认文案', 'Step 2: Review & Approve Script')}</h2>
              <div className="faceless-script-stats">
                <span className="faceless-stat-pill">
                  <FileText size={14} />
                  {wordCount} {l('词', 'words')}
                </span>
                <span className="faceless-stat-pill">
                  <Clock size={14} />
                  ~{estimatedReadMinutes} {l('分钟预估语速', 'mins read time')}
                </span>
                <span className={`faceless-stat-pill ${scriptApproved ? 'success' : 'warning'}`}>
                  <CheckCircle size={14} />
                  {scriptApproved ? l('已审核通过', 'Approved') : l('等待审核确认', 'Pending Approval')}
                </span>
              </div>
            </div>

            <div className="faceless-form-group">
              <label>{l('英文旁白解说文案 (支持自由修改，包含章节与 [Visual: ...] 画面提示)', 'English Documentary Script (Freely editable, includes chapters and [Visual: ...] scene prompts)')}</label>
              <textarea
                className="faceless-textarea faceless-script-editor"
                value={script}
                disabled={busy}
                onChange={e => {
                  setScript(e.target.value);
                  setScriptApproved(false);
                }}
                rows={16}
                placeholder="Your documentary script will appear here. You can freely edit, polish, or rewrite..."
              />
            </div>

            <div className="faceless-row">
              <div className="faceless-form-group">
                <label>{l('全局旁白配音音频路径 (可选，若下方章节上传独立音频则优先拼接章节音频)', 'Full Voiceover Audio Path (Optional, chapter audios take precedence)')}</label>
                <input
                  className="faceless-input"
                  value={audioFile}
                  disabled={busy}
                  onChange={e => setAudioFile(e.target.value)}
                  placeholder="/path/to/full_narration.mp3 (optional)"
                />
              </div>

              <div className="faceless-form-group">
                <label>{l('图片 / 素材路径列表 (每行一个，可选)', 'Footage / Image Paths (one per line, optional)')}</label>
                <textarea
                  className="faceless-textarea"
                  value={imagesText}
                  disabled={busy}
                  onChange={e => setImagesText(e.target.value)}
                  rows={2}
                  placeholder="/path/to/image1.jpg&#10;/path/to/image2.png"
                />
              </div>
            </div>

            <div className="faceless-actions">
              <button
                className="faceless-primary-button"
                type="button"
                disabled={busy || !script.trim()}
                onClick={handleApproveScript}
              >
                <CheckCircle size={16} />
                {l('审核通过，配置各章节音频与时间戳', 'Approve Script & Configure Chapters & Audio')}
              </button>

              <button
                className="faceless-secondary-button"
                type="button"
                disabled={busy}
                onClick={handleGenerateScript}
              >
                <RefreshCw size={15} />
                {l('重新生成文案', 'Regenerate Script')}
              </button>
            </div>
          </section>
        )}

        {/* Step 3: Chapter Audio Studio & YouTube Timestamps */}
        {currentStep === 2 && (
          <section className="faceless-card" aria-label="Step 3: Chapter Audio Studio">
            <div className="faceless-card-header">
              <h2>
                <Music size={18} />
                {l('第三步：章节管理与音频配置', 'Step 3: Chapters & Audio Studio')}
              </h2>
              <div className="faceless-script-stats">
                <span className="faceless-stat-pill">
                  <ListMusic size={14} />
                  {chapters.length} {l('个章节', 'chapters')}
                </span>
                <span className="faceless-stat-pill">
                  <Clock size={14} />
                  ~{Math.round(totalChapterDuration / 60 * 10) / 10} {l('分钟', 'mins')} ({totalChapterDuration}s)
                </span>
                <span className="faceless-stat-pill">
                  <FileText size={14} />
                  {wordCount} {l('词', 'words')}
                </span>
              </div>
            </div>

            {/* YouTube Chapter Timestamps Box */}
            <div className="faceless-timestamps-card">
              <div className="faceless-timestamps-header">
                <div className="faceless-timestamps-title">
                  <Sparkles size={16} />
                  <span>{l('YouTube Chapter Timestamps (自动计算章节时间戳)', 'YouTube Chapter Timestamps (Auto-calculated)')}</span>
                </div>
                <button
                  type="button"
                  className={`faceless-copy-btn ${copiedTimestamps ? 'copied' : ''}`}
                  onClick={handleCopyTimestamps}
                >
                  {copiedTimestamps ? <Check size={14} /> : <Copy size={14} />}
                  {copiedTimestamps ? l('已复制时间戳！', 'Copied Timestamps!') : l('一键复制时间戳', 'Copy Timestamps')}
                </button>
              </div>
              <pre className="faceless-timestamps-pre">{youtubeTimestamps || l('(暂无章节时间戳)', '(No timestamps available)')}</pre>
              <p className="faceless-timestamps-hint">
                {l(
                  '💡 复制此时间戳直接粘贴到 YouTube 视频的简介 (Description) 中，YouTube 将自动生成可点击的章节进度条！第一行必须以 00:00 开头。',
                  '💡 Copy and paste these timestamps directly into your YouTube video Description. YouTube will automatically generate chapter progress markers! First timestamp starts at 00:00.'
                )}
              </p>
            </div>

            {/* Chapters List */}
            <div className="faceless-chapters-list">
              {chapters.map((chap, idx) => {
                const audioSrc = chapterAudioUrls[chap.id] || (chap.audioPath ? `file://${chap.audioPath}` : '');
                const cleanSnippet = cleanChapterNarrationText(chap.text);

                return (
                  <div className="faceless-chapter-card" key={chap.id}>
                    <div className="faceless-chapter-header">
                      <div className="faceless-chapter-title-group">
                        <span className="faceless-chapter-badge">#{idx + 1}</span>
                        <input
                          className="faceless-chapter-title-input"
                          value={chap.title}
                          onChange={e => handleUpdateChapter(chap.id, { title: e.target.value })}
                          title={l('点击修改章节标题', 'Click to edit chapter title')}
                        />
                      </div>

                      <div className="faceless-chapter-meta-group">
                        <span className="faceless-chapter-timestamp-pill" title={l('YouTube 开始时间点', 'YouTube start timestamp')}>
                          <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
                          {idx === 0 ? '00:00' : formatYoutubeTimestamp(chap.startOffset ?? 0)}
                        </span>
                        <span className="faceless-stat-pill">
                          {chap.wordCount ?? 0} {l('词', 'words')}
                        </span>
                        <span className="faceless-stat-pill">
                          ~{chap.duration ?? 0}s
                        </span>
                        <span className={`faceless-stat-pill ${chap.audioPath ? 'success' : ''}`}>
                          <Volume2 size={12} />
                          {chap.audioPath ? l('已配音频', 'Audio Ready') : l('自动预估时长', 'Auto Duration')}
                        </span>
                      </div>
                    </div>

                    <div className="faceless-chapter-body">
                      {/* Narration Preview */}
                      {cleanSnippet ? (
                        <div className="faceless-chapter-text-preview" title={l('章节解说旁白文案', 'Chapter narration text')}>
                          {cleanSnippet}
                        </div>
                      ) : null}

                      {/* Controls Row */}
                      <div className="faceless-chapter-audio-controls">
                        <div className="faceless-form-group">
                          <label>{l('预计时长 (秒)', 'Duration (seconds)')}</label>
                          <input
                            type="number"
                            min={2}
                            max={1800}
                            step={1}
                            className="faceless-input"
                            value={chap.duration ?? 60}
                            onChange={e => {
                              const dur = Math.max(2, Number(e.target.value) || 30);
                              handleUpdateChapter(chap.id, { duration: dur });
                            }}
                          />
                        </div>

                        <div className="faceless-form-group">
                          <label>{l('章节独立音频文件 (本地路径或选择文件)', 'Chapter Audio File (Local path or select file)')}</label>
                          <div className="faceless-audio-upload-wrapper">
                            <input
                              className="faceless-input"
                              style={{ flex: 1 }}
                              value={chap.audioPath || ''}
                              onChange={e => handleUpdateChapter(chap.id, { audioPath: e.target.value })}
                              placeholder={`/path/to/chapter_${idx + 1}_audio.mp3`}
                            />
                            <label className="faceless-file-upload-btn">
                              <Upload size={14} />
                              <span>{l('选择文件', 'Choose File')}</span>
                              <input
                                type="file"
                                accept="audio/*"
                                style={{ display: 'none' }}
                                onChange={e => {
                                  const file = e.target.files?.[0];
                                  if (file) handleChapterFileUpload(chap.id, file);
                                }}
                              />
                            </label>
                          </div>
                        </div>
                      </div>

                      {/* Audio Player if available */}
                      {audioSrc ? (
                        <audio
                          className="faceless-chapter-audio-player"
                          controls
                          src={audioSrc}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="faceless-actions">
              <button
                className="faceless-primary-button"
                type="button"
                disabled={busy}
                onClick={handleConfirmChaptersAndGenerateTimeline}
              >
                {isGeneratingTimeline ? (
                  <LoaderCircle className="animate-spin" size={16} />
                ) : (
                  <CheckCircle size={16} />
                )}
                {isGeneratingTimeline
                  ? l('正在拼接音频并生成分镜时间线…', 'Stitching Audio & Generating Timeline…')
                  : l('确认章节设置，生成分镜时间线', 'Confirm Chapters & Generate Shot Timeline')}
              </button>

              <button
                className="faceless-secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setCurrentStep(1)}
              >
                <ChevronLeft size={15} />
                {l('返回文案审核', 'Back to Script')}
              </button>

              <button
                className="faceless-secondary-button"
                type="button"
                disabled={busy}
                onClick={handleReparseChapters}
              >
                <RefreshCw size={15} />
                {l('从文案重新提取章节', 'Re-extract Chapters')}
              </button>
            </div>
          </section>
        )}

        {/* Step 4: Timeline Preview */}
        {currentStep === 3 && (
          <section className="faceless-card" aria-label="Step 4: Shot Timeline">
            <div className="faceless-card-header">
              <h2>
                <Layers size={18} />
                {l('第四步：分镜时间线', 'Step 4: Shot Timeline')}
                {timelineData ? ` (${timelineData.shots.length} ${l('个分镜', 'shots')}, ${Math.round(timelineData.totalDuration / 60 * 10) / 10} ${l('分钟', 'mins')} / ${timelineData.totalDuration}s)` : ''}
              </h2>
            </div>

            {timelineData ? (
              <>
                {/* Chapter Filter Bar */}
                {chapters.length > 0 ? (
                  <div className="faceless-chapter-filter-bar">
                    <span className="faceless-filter-label">
                      <Filter size={13} />
                      {l('章节快速定位:', 'Chapter Filter:')}
                    </span>
                    <button
                      type="button"
                      className={`faceless-chapter-filter-pill ${selectedChapterFilter === 'all' ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedChapterFilter('all');
                        setShotPage(1);
                      }}
                    >
                      {l('全部章节', 'All Chapters')} ({timelineData.shots.length})
                    </button>
                    {chapters.map(chap => {
                      const count = timelineData.shots.filter(s => s.chapterId === chap.id).length;
                      return (
                        <button
                          key={chap.id}
                          type="button"
                          className={`faceless-chapter-filter-pill ${selectedChapterFilter === chap.id ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedChapterFilter(chap.id);
                            setShotPage(1);
                          }}
                        >
                          {chap.title} {count > 0 ? `(${count})` : ''}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {/* Search & Pagination Toolbar */}
                <div className="faceless-timeline-toolbar">
                  <div className="faceless-search-box">
                    <Search size={15} className="faceless-search-icon" />
                    <input
                      className="faceless-search-input"
                      value={shotSearch}
                      onChange={e => {
                        setShotSearch(e.target.value);
                        setShotPage(1);
                      }}
                      placeholder={l('搜索分镜内容、编号或运镜 (#1, zoom-in, Japan...)...', 'Search shots by text, #index, or motion...')}
                    />
                    {shotSearch ? (
                      <button
                        type="button"
                        className="faceless-search-clear"
                        onClick={() => {
                          setShotSearch('');
                          setShotPage(1);
                        }}
                      >
                        <X size={13} />
                      </button>
                    ) : null}
                  </div>

                  <div className="faceless-toolbar-controls">
                    <span className="faceless-toolbar-info">
                      {l('显示', 'Showing')}{' '}
                      <strong>
                        {filteredShots.length === 0 ? 0 : (pageSize === 0 ? 1 : (currentPage - 1) * pageSize + 1)}
                        {' - '}
                        {pageSize === 0 ? filteredShots.length : Math.min(filteredShots.length, currentPage * pageSize)}
                      </strong>{' '}
                      / {filteredShots.length} {l('个分镜', 'shots')}
                      {filteredShots.length !== timelineData.shots.length ? ` (${l('过滤自', 'filtered from')} ${timelineData.shots.length})` : ''}
                    </span>

                    <select
                      className="faceless-pagesize-select"
                      value={pageSize}
                      onChange={e => {
                        setPageSize(Number(e.target.value));
                        setShotPage(1);
                      }}
                    >
                      <option value={24}>24 {l('个/页', '/ page')}</option>
                      <option value={48}>48 {l('个/页', '/ page')}</option>
                      <option value={96}>96 {l('个/页', '/ page')}</option>
                      <option value={0}>{l('全部显示 (All)', 'Show All')}</option>
                    </select>
                  </div>
                </div>

                {/* Shots Grid */}
                <div className="faceless-shots-grid">
                  {paginatedShots.map(shot => {
                    const time = shotTimestamps[shot.order];
                    const matchedChap = chapters.find(c => c.id === shot.chapterId);

                    return (
                      <div
                        className="faceless-shot-item clickable"
                        key={shot.id}
                        onClick={() => setSelectedShotIndex(shot.order)}
                        title={l('点击查看 / 编辑分镜详情', 'Click to view / edit shot details')}
                      >
                        <div className="faceless-shot-header">
                          <span className="faceless-shot-badge">Shot #{shot.order + 1}</span>
                          <span className="faceless-shot-duration">
                            {formatTimestamp(time?.start ?? 0)} - {formatTimestamp(time?.end ?? 0)}
                          </span>
                        </div>
                        <div className="faceless-shot-meta-row">
                          <span className="faceless-shot-motion">{shot.motion}</span>
                          <span className="faceless-shot-time-pill">{shot.duration}s</span>
                          {matchedChap ? (
                            <span className="faceless-shot-chapter-pill" title={matchedChap.title}>
                              {matchedChap.title}
                            </span>
                          ) : null}
                        </div>
                        {shot.text ? (
                          <p className="faceless-shot-text">{shot.text}</p>
                        ) : (
                          <p className="faceless-shot-text empty">{l('(无配音文案)', '(No narration text)')}</p>
                        )}
                        <div className="faceless-shot-inspect-hint">
                          <Eye size={12} />
                          <span>{l('查看详情', 'View Details')}</span>
                        </div>
                      </div>
                    );
                  })}
                  {paginatedShots.length === 0 ? (
                    <div style={{ gridColumn: '1 / -1', padding: '36px 0', textAlign: 'center', color: 'var(--muted)' }}>
                      <p>{l('没有找到匹配的分镜', 'No matching shots found')}</p>
                    </div>
                  ) : null}
                </div>

                {/* Pagination Controls */}
                {pageSize > 0 && totalPages > 1 ? (
                  <div className="faceless-pagination-bar">
                    <button
                      type="button"
                      className="faceless-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() => setShotPage(1)}
                      title={l('第一页', 'First page')}
                    >
                      <ChevronsLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="faceless-page-btn"
                      disabled={currentPage <= 1}
                      onClick={() => setShotPage(p => Math.max(1, p - 1))}
                      title={l('上一页', 'Previous page')}
                    >
                      <ChevronLeft size={16} />
                    </button>

                    <div className="faceless-page-numbers">
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                        .map((p, idx, arr) => {
                          const prev = arr[idx - 1];
                          const hasGap = prev !== undefined && p - prev > 1;
                          return (
                            <span key={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
                              {hasGap ? <span className="faceless-page-ellipsis">…</span> : null}
                              <button
                                type="button"
                                className={`faceless-page-num-btn ${p === currentPage ? 'active' : ''}`}
                                onClick={() => setShotPage(p)}
                              >
                                {p}
                              </button>
                            </span>
                          );
                        })}
                    </div>

                    <button
                      type="button"
                      className="faceless-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() => setShotPage(p => Math.min(totalPages, p + 1))}
                      title={l('下一页', 'Next page')}
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="faceless-page-btn"
                      disabled={currentPage >= totalPages}
                      onClick={() => setShotPage(totalPages)}
                      title={l('最后一页', 'Last page')}
                    >
                      <ChevronsRight size={16} />
                    </button>
                  </div>
                ) : null}

                <div className="faceless-actions">
                  <button
                    className="faceless-primary-button"
                    type="button"
                    disabled={busy}
                    onClick={handleRenderVideo}
                  >
                    {isRendering ? (
                      <LoaderCircle className="animate-spin" size={16} />
                    ) : (
                      <Video size={16} />
                    )}
                    {isRendering ? l('正在分段渲染 1080p 视频…', 'Rendering 1080p Video…') : l('开始渲染成片 (Render MP4)', 'Render Final Video')}
                  </button>

                  <button
                    className="faceless-secondary-button"
                    type="button"
                    onClick={() => setCurrentStep(2)}
                  >
                    <Music size={15} />
                    {l('返回调整章节与音频', 'Back to Chapters & Audio')}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)' }}>
                <p>{l('尚未生成分镜时间线，请先在章节管理中确认生成。', 'Timeline not generated yet. Please confirm chapters first.')}</p>
                <button
                  className="faceless-primary-button"
                  type="button"
                  style={{ marginTop: 12 }}
                  onClick={() => setCurrentStep(2)}
                >
                  <Music size={16} />
                  {l('前往章节与配音管理', 'Go to Chapters & Audio Studio')}
                </button>
              </div>
            )}
          </section>
        )}

        {/* Step 5: Final Output */}
        {currentStep === 4 && (
          <section className="faceless-card" aria-label="Step 5: Final Output">
            <div className="faceless-card-header">
              <h2><Sparkles size={18} /> {l('第五步：成片预览与下载', 'Step 5: Preview & Download')}</h2>
            </div>

            {renderFailed && (
              <div className="faceless-error-banner" role="alert">
                <AlertCircle size={22} className="faceless-error-icon" />
                <div className="faceless-error-content">
                  <strong>{l('视频渲染未成功完成', 'Video Rendering Did Not Complete')}</strong>
                  <p>{renderErrorMessage}</p>
                </div>
                <button
                  type="button"
                  className="faceless-primary-button"
                  style={{ padding: '8px 14px', fontSize: 13, flexShrink: 0 }}
                  onClick={handleRetryRender}
                >
                  <RotateCw size={14} />
                  {l('重试渲染', 'Retry Render')}
                </button>
              </div>
            )}

            {videoUrl ? (
              <>
                <video
                  key={videoArtifactId}
                  className="faceless-result-video"
                  controls
                  playsInline
                  src={videoUrl}
                />

                {/* YouTube Timestamps Box ready for copy on final download */}
                {youtubeTimestamps ? (
                  <div className="faceless-timestamps-card" style={{ marginTop: 8 }}>
                    <div className="faceless-timestamps-header">
                      <div className="faceless-timestamps-title">
                        <Sparkles size={16} />
                        <span>{l('YouTube 章节时间戳 (可直接粘贴至 YouTube 简介)', 'YouTube Chapter Timestamps (Ready to paste in description)')}</span>
                      </div>
                      <button
                        type="button"
                        className={`faceless-copy-btn ${copiedTimestamps ? 'copied' : ''}`}
                        onClick={handleCopyTimestamps}
                      >
                        {copiedTimestamps ? <Check size={14} /> : <Copy size={14} />}
                        {copiedTimestamps ? l('已复制时间戳！', 'Copied Timestamps!') : l('一键复制时间戳', 'Copy Timestamps')}
                      </button>
                    </div>
                    <pre className="faceless-timestamps-pre">{youtubeTimestamps}</pre>
                  </div>
                ) : null}

                <div className="faceless-actions">
                  <button
                    className="faceless-primary-button"
                    type="button"
                    onClick={handleDownload}
                  >
                    <Download size={16} />
                    {l('下载 1080p MP4', 'Download 1080p MP4')}
                  </button>

                  <button
                    className="faceless-secondary-button"
                    type="button"
                    onClick={() => setCurrentStep(3)}
                  >
                    <Layers size={15} />
                    {l('查看分镜', 'View Shots')}
                  </button>
                </div>
              </>
            ) : isRendering ? (
              <div className="faceless-render-progress-card">
                <LoaderCircle className="animate-spin" size={36} style={{ margin: '0 auto 12px auto', display: 'block', color: 'var(--primary)' }} />
                <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
                  {renderPhaseText} {renderCountText}
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                  {l('正在采用 Ken Burns 运镜与多核并发进行分块渲染…', 'Applying Ken Burns motions with multi-threaded chunked rendering…')}
                </p>

                <div className="faceless-progress-bar-container">
                  <div
                    className="faceless-progress-bar-fill"
                    style={{ width: `${Math.max(5, Math.min(100, renderPercent))}%` }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  <span>{renderPhaseText}</span>
                  <strong>{renderPercent}%</strong>
                </div>
              </div>
            ) : !renderFailed ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)' }}>
                <p>{l('尚未渲染视频。', 'Video has not been rendered yet.')}</p>
                <button
                  className="faceless-primary-button"
                  type="button"
                  style={{ marginTop: 12 }}
                  onClick={handleRenderVideo}
                >
                  <Video size={16} />
                  {l('立即渲染 1080p MP4', 'Render 1080p MP4 Now')}
                </button>
              </div>
            ) : null}
          </section>
        )}

        {/* Shot Detail Modal */}
        {selectedShotIndex !== null && timelineData && timelineData.shots[selectedShotIndex] && (() => {
          const shot = timelineData.shots[selectedShotIndex]!;
          const time = shotTimestamps[selectedShotIndex];
          const matchedChap = chapters.find(c => c.id === shot.chapterId);
          const hasPrev = selectedShotIndex > 0;
          const hasNext = selectedShotIndex < timelineData.shots.length - 1;

          return (
            <div className="faceless-modal-backdrop" onClick={() => setSelectedShotIndex(null)}>
              <div className="faceless-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="faceless-modal-header">
                  <div className="faceless-modal-title">
                    <Layers size={18} />
                    <h3>Shot #{selectedShotIndex + 1} / {timelineData.shots.length}</h3>
                    {matchedChap ? (
                      <span className="faceless-shot-chapter-pill" title={matchedChap.title}>
                        {matchedChap.title}
                      </span>
                    ) : null}
                    <span className="faceless-stat-pill">
                      <Clock size={12} />
                      {formatTimestamp(time?.start ?? 0)} - {formatTimestamp(time?.end ?? 0)} ({shot.duration}s)
                    </span>
                  </div>
                  <button
                    type="button"
                    className="faceless-modal-close-btn"
                    onClick={() => setSelectedShotIndex(null)}
                    title={l('关闭', 'Close')}
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="faceless-modal-body">
                  <div className="faceless-form-group">
                    <label>{l('分镜配音台词 / 字幕 (Narration / Subtitle Text)', 'Shot Narration / Subtitle Text')}</label>
                    <textarea
                      className="faceless-textarea"
                      rows={4}
                      value={shot.text || ''}
                      onChange={e => handleUpdateShot(selectedShotIndex, { text: e.target.value })}
                      placeholder={l('输入该分镜对应的解说旁白…', 'Enter narration text for this shot…')}
                    />
                  </div>

                  <div className="faceless-row">
                    <div className="faceless-form-group">
                      <label>{l('运镜效果 (Camera Motion)', 'Camera Motion Effect')}</label>
                      <select
                        className="faceless-input"
                        value={shot.motion}
                        onChange={e => handleUpdateShot(selectedShotIndex, { motion: e.target.value as FacelessShotMotion })}
                      >
                        <option value="zoom-in">Zoom In (缓慢放大推进)</option>
                        <option value="zoom-out">Zoom Out (缓缓拉远全景)</option>
                        <option value="pan-left">Pan Left (向左平移视线)</option>
                        <option value="pan-right">Pan Right (向右平移视线)</option>
                        <option value="static">Static (镜头静止固定)</option>
                      </select>
                    </div>

                    <div className="faceless-form-group">
                      <label>{l('镜头时长 (Duration in Seconds)', 'Shot Duration (seconds)')}</label>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        step={0.5}
                        className="faceless-input"
                        value={shot.duration}
                        onChange={e => {
                          const val = Math.max(0.5, Math.min(60, Number(e.target.value) || 5));
                          handleUpdateShot(selectedShotIndex, { duration: val });
                        }}
                      />
                    </div>
                  </div>

                  <div className="faceless-form-group">
                    <label>{l('视觉素材路径 (Image / Footage Path)', 'Visual Footage Path')}</label>
                    <input
                      className="faceless-input"
                      value={shot.mediaPath || ''}
                      onChange={e => handleUpdateShot(selectedShotIndex, { mediaPath: e.target.value })}
                      placeholder="/path/to/shot_image.jpg (optional)"
                    />
                    <small style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, display: 'block' }}>
                      {l('留空时将自动使用高质量暗色极简背景配合 Ken Burns 运镜', 'Leave empty to automatically render with smooth Ken Burns motions')}
                    </small>
                  </div>
                </div>

                <div className="faceless-modal-footer">
                  <div className="faceless-modal-nav">
                    <button
                      type="button"
                      className="faceless-secondary-button"
                      disabled={!hasPrev}
                      onClick={() => setSelectedShotIndex(selectedShotIndex - 1)}
                    >
                      <ChevronLeft size={16} />
                      {l('上一个分镜', 'Previous Shot')}
                    </button>
                    <button
                      type="button"
                      className="faceless-secondary-button"
                      disabled={!hasNext}
                      onClick={() => setSelectedShotIndex(selectedShotIndex + 1)}
                    >
                      {l('下一个分镜', 'Next Shot')}
                      <ChevronRight size={16} />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="faceless-primary-button"
                    onClick={() => setSelectedShotIndex(null)}
                  >
                    <CheckCircle size={16} />
                    {l('完成', 'Done')}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </CreatorToolShell>
  );
}
