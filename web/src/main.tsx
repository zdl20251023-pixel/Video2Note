import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { BookOpen, FileText, Link2, Download, Settings2, CircleCheck, CircleAlert, LoaderCircle, Image as ImageIcon, Clock3, X, Plus, Play, ShieldCheck, FolderDown, LogIn, Check, Layers3, RotateCcw, Square, Captions } from 'lucide-react';
import './style.css';
import { ModelControls, modelApi, type Catalog, type Selection } from './models';

type Frame = { file: string; time: number; text: string; confidence: number; keyFile?: string; description?: string; reason?: string; state?: Record<string, string>; background?: string; visualFacts?: string[]; streetTimeline?: { street: string; players: string; board: string; actions: string; amounts: string; commentary: string; sourceType: string }[]; teachingMeaning?: string; uncertainties?: string[] };
type BatchError = { batch: number; stage: string; message: string; imageCount: number };
type RefinedOutput = { file: string; status: string; available: boolean; stale: boolean; sourceMissing: boolean; sourcePartial: boolean; error?: string; inputChars?: number; outputChars?: number };
type Artifacts = { refinement?: { outputs: Record<'video' | 'script', RefinedOutput> };  errors?: BatchError[]; taskId: string; documents: string[]; keyframes: Frame[]; artifactStatus?: { information: string; lesson: string; visualDetails?: string } | null };
const frameLabels: Record<string, string> = { positions: '人物与位置', holeCards: '手牌及花色', board: '公共牌及花色', pot: '底池与单位', stacks: '筹码与单位', actions: '行动与下注', overlays: '画面教学文字' };
type Analysis = { total: number; analyzed: number; failed: number; batches: number; completedBatches: number; failedBatches: number; enabled: boolean; errors?: BatchError[] };
type Task = {
  refinement?: { jobId?: string; status: string; message?: string; progress?: number };
  analysis?: Analysis; outputDirectory?: string;
  platform?: string;
  id: string; url: string; source: string; title: string; status: string; stage: string; progress: number;
  message: string; createdAt: string; updatedAt: string; duration?: number; elapsed?: number; frameCount?: number;
  options: { ocr: boolean; frameInterval: number; modelSelection?: Selection; includeImages?: boolean; transcribe?: boolean };
  model?: { providerLabel: string; modelLabel: string; modelId: string } | null;
  result?: { documents?: string[]; keyframes?: Frame[]; analysis?: Analysis; platform?: string; validationMethod?: string; captionSources?: Record<string, { kind: string; provider?: string; segmentSeconds?: number }>; fullPlayback: boolean; coveredSeconds: number; duration: number; frameCount: number; cueCount: number; language: string | null; warnings: string[]; frames: Frame[]; captions: Record<string, string>; hasAudio: boolean; noteMode?: string; model?: { providerLabel: string; modelLabel: string; modelId: string; imagesSent: number } | null; aiError?: string | null };
};
type Status = { browserConnected: boolean; sessionSaved: boolean; sampleAvailable: boolean; activeTaskId: string | null; mediaToolReady?: boolean; platformSessions?: Record<string, boolean> };
type Platform = { id: string; label: string; example: string; loginUrl: string };
const platformLabel = (id?: string) => ({ pokercoaching: 'PokerCoaching', youtube: 'YouTube', bilibili: 'B站' }[id || 'pokercoaching'] || id);
const inferPlatform = (value: string) => { try { const host = new URL(value).hostname; return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host) ? 'youtube' : ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) ? 'bilibili' : host === 'pokercoaching.com' ? 'pokercoaching' : null; } catch { return null; } };
const SAMPLE = 'https://pokercoaching.com/courses/complete-cash-game-system/welcome-to-the-complete-cash-game-system/';
const statusLabels: Record<string, string> = { queued: '排队中', running: '处理中', cancelling: '取消中', completed: '已完成', partial: '部分内容', failed: '处理失败', cancelled: '已取消' };
const stages = [
  { key: 'inspecting', label: '识别视频', icon: Link2 }, { key: 'playing', label: '提取内容', icon: Play },
  { key: 'transcribing', label: '语音转写', icon: Captions },
  { key: 'ocr', label: '画面识别', icon: ImageIcon }, { key: 'summarizing', label: '信息与讲稿', icon: FileText }, { key: 'refining', label: '重点提炼', icon: FileText },
];
const isActive = (task?: Task) => !!task && ['queued', 'running', 'cancelling'].includes(task.status);
const time = (seconds = 0) => {
  const value = Math.floor(seconds);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
const fileUrl = (id: string, file: string, download = false) => `/api/tasks/${id}/file?path=${encodeURIComponent(file)}${download ? '&download=1' : ''}`;

function Markdown({ value, id }: { value: string; id: string }) {
  const html = useMemo(() => {
    const parsed = new DOMParser().parseFromString(marked.parse(value, { async: false }) as string, 'text/html');
    parsed.querySelectorAll('img').forEach(image => {
      const src = image.getAttribute('src') || '';
      if (/^(images|keyframes)\/frame-\d+\.png$/.test(src)) {
        const link = parsed.createElement('a'); link.href = fileUrl(id, src); link.textContent = `查看图片证据：${image.getAttribute('alt') || src}`; image.replaceWith(link);
      } else image.remove();
    });
    parsed.querySelectorAll('a').forEach(link => { const href = link.getAttribute('href') || ''; if (/^(images|keyframes)\/frame-\d+\.png$/.test(href)) link.setAttribute('href', fileUrl(id, href)); link.target = '_blank'; link.rel = 'noreferrer noopener'; });
    return DOMPurify.sanitize(parsed.body.innerHTML);
  }, [value, id]);
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('task') || '');
  const [url, setUrl] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platformId, setPlatformId] = useState('youtube');
  const [transcribe, setTranscribe] = useState(true);
  const [ocr, setOcr] = useState(true);
  const [interval, setIntervalValue] = useState(5);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState<Selection>({ providerId: 'deepseek', modelId: 'deepseek-flash' });
  const [includeImages, setIncludeImages] = useState(true);
  const [tab, setTab] = useState('note');
  const [view, setView] = useState('workspace');
  const [note, setNote] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState('');
  const [artifactState, setArtifactState] = useState<Artifacts | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const task = tasks.find(item => item.id === selected);
  const artifacts = artifactState?.taskId === task?.id ? artifactState : null;
  const documents = artifacts?.documents || task?.result?.documents || [];
  const keyFrames = artifacts?.keyframes || task?.result?.keyframes || [];
  const informationFile = documents.find(file => ['视频信息整理.md', '视频解析.md', '学习笔记.md'].includes(file)) || '学习笔记.md';
  const documentFile = tab === 'note' ? informationFile : ({ script: '教学讲稿.md', 'video-summary': '视频重点.md', 'script-summary': '精简讲稿.md' } as Record<string, string>)[tab];
  const refinedKind = tab === 'video-summary' ? 'video' : tab === 'script-summary' ? 'script' : null;
  const refinedOutput = refinedKind ? artifacts?.refinement?.outputs[refinedKind] : undefined;
  const refinementBusy = !!task?.refinement && ['queued', 'running', 'cancelling'].includes(task.refinement.status);
  const activeTask = tasks.find(item => item.id === status?.activeTaskId) || tasks.find(item => isActive(item));
  const completed = tasks.filter(item => item.status === 'completed' || item.status === 'partial').length;
  const selectedProvider = catalog?.providers.find(item => item.id === selection.providerId);
  const selectedModel = selectedProvider?.models.find(model => model.id === selection.modelId);
  const canRun = !!catalog && (selection.providerId === 'local' || !!selectedProvider?.hasKey && (!includeImages || !!selectedModel?.vision));
  const canRefine = !!selectedProvider?.hasKey && selection.providerId !== 'local';
  const speechProvider = catalog?.speechProviders?.find(provider => provider.id === 'deepseek') || catalog?.speechProviders?.[0];
  const currentOptions = { ocr, frameInterval: interval, modelSelection: selection, includeImages, transcribe: selection.providerId !== 'local' && transcribe && !!speechProvider?.hasKey, speechProviderId: speechProvider?.id || 'deepseek' };
  const sessionSaved = status?.platformSessions?.[platformId] ?? (platformId === 'pokercoaching' && status?.sessionSaved);
  function updateUrl(value: string) { setUrl(value); const detected = inferPlatform(value); if (detected) setPlatformId(detected); }
  function updateCatalog(next: Catalog) {
    setCatalog(next);
    setSelection(previous => previous.providerId === 'local' || next.providers.some(provider => provider.id === previous.providerId && provider.models.some(model => model.id === previous.modelId)) ? previous : next.defaultSelection);
  }
  async function changeSelection(next: Selection) {
    setSelection(next);
    try { updateCatalog(await modelApi<Catalog>('/preferences', { selection: next })); }
    catch (error) { setNotice({ text: (error as Error).message, error: true }); }
  }
  async function refresh() {
    const [nextTasks, nextStatus] = await Promise.all([api<Task[]>('/tasks'), api<Status>('/status')]);
    setTasks(nextTasks); setStatus(nextStatus);
  }
  useEffect(() => {
    api<Platform[]>('/platforms').then(setPlatforms).catch(error => setNotice({ text: error.message, error: true }));
    modelApi<Catalog>('').then(next => { setCatalog(next); setSelection(next.defaultSelection); }).catch(error => setNotice({ text: error.message, error: true }));
    refresh().catch(error => setNotice({ text: error.message, error: true }));
    const handle = window.setInterval(() => refresh().catch(() => {}), 2000);
    return () => window.clearInterval(handle);
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => { if (task?.result) api<Omit<Artifacts, 'taskId'>>(`/tasks/${task.id}/artifacts`).then(result => { if (live) setArtifactState({ ...result, taskId: task.id }); }).catch(() => { if (live) setArtifactState({ taskId: task.id, documents: task.result?.documents || [], keyframes: task.result?.keyframes || [] }); }); };
    load(); const timer = window.setInterval(load, 10000);
    return () => { live = false; window.clearInterval(timer); };
  }, [task?.id, task?.updatedAt, !!task?.result]);
  useEffect(() => {
    setNote(''); setNoteError(''); setNoteLoading(false);
    if (!task?.result || !['note', 'script', 'video-summary', 'script-summary'].includes(tab)) return;
    if (tab !== 'note' && !artifacts) { setNoteLoading(true); return; }
    if (tab !== 'note' && !documents.includes(documentFile)) return;
    const controller = new AbortController(); let live = true;
    setNoteLoading(true);
    fetch(tab !== 'note' ? fileUrl(task.id, documentFile) : `/api/tasks/${task.id}/note`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(`${documentFile} 尚未生成或读取失败，请重试对应步骤。`);
      return response.text();
    }).then(value => { if (live) setNote(value); }).catch(error => { if (live && error.name !== 'AbortError') setNoteError(error.message); }).finally(() => { if (live) setNoteLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [task?.id, task?.updatedAt, !!task?.result, tab, artifacts?.documents.join('|')]);
  async function generateRefinements(target = 'both', force = false) {
    if (!task) return;
    await action('refine', async () => {
      await api(`/tasks/${task.id}/refine`, { selection, target, force });
    });
  }
  function choose(id: string) {
    setSelected(id); setTab('note');
    history.replaceState(null, '', `${location.pathname}?task=${id}`);
  }
  async function action(key: string, operation: () => Promise<void>) {
    setBusy(key); setNotice(null);
    try { await operation(); await refresh(); }
    catch (error) { setNotice({ text: (error as Error).message, error: true }); }
    finally { setBusy(''); }
  }
  async function create(sample = false) {
    await action(sample ? 'sample' : 'create', async () => {
      const created = await api<Task>(sample ? '/tasks/sample' : '/tasks', { url, options: currentOptions });
      choose(created.id); setView('workspace');
    });
  }
  async function login(capture = false) {
    await action(capture ? 'capture' : 'login', async () => {
      const result = await api<{ message: string }>(capture ? '/login/capture' : '/login/open', { platform: platformId });
      setNotice({ text: result.message, error: false });
    });
  }
  const visibleTasks = view === 'history' ? tasks : tasks.slice(0, 12);
  let stageIndex = stages.findIndex(stage => stage.key === task?.stage);
  if (task?.stage === 'extracting') stageIndex = 1;
  if (task?.stage === 'downloading') stageIndex = 1;
  if (task?.result && !isActive(task)) stageIndex = stages.length;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Poker Notes 首页"><span className="brand-mark">♣</span><span>Poker<span className="brand-light">Notes</span><small>把知识留在牌桌之外</small></span></a>
      <div className="sidebar-label">你的学习空间</div>
      <nav aria-label="主导航">
        <button className={view === 'workspace' ? 'nav-item active' : 'nav-item'} onClick={() => setView('workspace')}><BookOpen size={19} />视频资料<span>{completed || '—'}</span></button>
        <button className={view === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setView('history')}><Clock3 size={19} />处理记录<span>{tasks.length || '—'}</span></button>
      </nav>
      <div className="sidebar-tip"><div className="mini-card-icon"><Layers3 size={22} /></div><h3>每一节课，都有收获</h3><p>让讲解、画面与时间戳<br />成为可以反复复习的笔记。</p><div className="suits">♠ <span>♥</span> ♣ <span>♦</span></div></div>
      <div className="local-card"><ShieldCheck size={19} /><div><strong>{selection.providerId === 'local' ? '本地学习模式' : `${selectedProvider?.label || '模型'} 总结`}</strong><small>{selection.providerId === 'local' ? '字幕整理 · 离线 OCR' : canRun ? '语义总结 · 本地保存' : '请先配置 API Key'}</small></div><span className="local-dot" /></div>
      <div className="sidebar-footer">多平台视频信息整理 · V0.2</div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="breadcrumb">学习空间<span>/</span><strong>{view === 'workspace' ? '课程笔记' : '处理记录'}</strong></div><span className="local-pill"><ShieldCheck size={14} />本地工作台</span></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow">WATCH. UNDERSTAND. REMEMBER.</div><h1>{view === 'workspace' ? '视频学习笔记' : '你的处理记录'}</h1><p>保存有价值的讲解，把每一次学习变成自己的积累。</p></div><span className="heading-icon"><BookOpen size={31} strokeWidth={1.4} /></span></div>
        {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={18} /> : <CircleCheck size={18} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}

        {view === 'workspace' && <section className="composer panel" aria-labelledby="new-note-title">
          <div className="section-title"><span className="icon-tile"><Plus size={19} /></span><div><h2 id="new-note-title">从一个视频开始</h2><p>支持 YouTube、B站和 PokerCoaching，链接会自动识别平台。</p></div><span className="tag">单视频处理</span></div>
          <div className="platform-row"><label htmlFor="video-platform">视频平台</label><select id="video-platform" value={platformId} onChange={event => { setPlatformId(event.target.value); if (url && inferPlatform(url) !== event.target.value) setUrl(''); }}>{platforms.map(platform => <option key={platform.id} value={platform.id}>{platform.label}</option>)}</select><span className="platform-note">{platformId === 'pokercoaching' ? '使用独立浏览器连续播放提取' : '优先下载媒体及站点字幕，公开内容通常无需登录'}</span></div>
          <form onSubmit={event => { event.preventDefault(); create(); }}>
            <label className="field-label" htmlFor="course-url">视频链接</label>
            <div className="url-row"><div className="url-field"><Link2 size={19} /><input id="course-url" type="url" value={url} onChange={event => updateUrl(event.target.value)} placeholder="粘贴 YouTube、B站或 PokerCoaching 视频链接" required /></div><button className="primary" disabled={!!busy || !url.trim() || !canRun || platformId !== 'pokercoaching' && !status?.mediaToolReady}>{busy === 'create' ? <LoaderCircle className="spin" size={18} /> : <FileText size={18} />}整理视频信息</button></div>
            <div className="composer-options"><div className="options-left"><label className="check-label"><input type="checkbox" checked={ocr} onChange={event => setOcr(event.target.checked)} />识别画面文字 <span className="option-tag">OCR</span></label><span className="divider" /><label className="interval-label"><Settings2 size={15} />截图间隔<select aria-label="截图间隔" value={interval} onChange={event => setIntervalValue(Number(event.target.value))}><option value={3}>3 秒</option><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={15}>15 秒</option><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={120}>120 秒</option></select></label></div><button type="button" className="text-button" onClick={() => updateUrl(platforms.find(platform => platform.id === platformId)?.example || SAMPLE)}>填入示例链接</button></div>
          </form>
          <ModelControls catalog={catalog} selection={selection} includeImages={includeImages} onImages={setIncludeImages} onChange={changeSelection} onCatalog={updateCatalog} onError={text => setNotice({ text, error: true })} />
          <div className="speech-row"><label className="check-label"><input type="checkbox" checked={currentOptions.transcribe} disabled={selection.providerId === 'local' || !speechProvider?.hasKey} onChange={event => setTranscribe(event.target.checked)} />无字幕时语音识别{speechProvider ? `（${speechProvider.label}）` : ''}</label><p>{selection.providerId === 'local' ? '本地整理不自动发送音频；无字幕时仅保留音频和画面。' : speechProvider?.hasKey ? `仅在没有可用字幕时，将音频分段发送至 ${speechProvider.label}，按该服务计费；时间戳为约 ${speechProvider.segmentSeconds} 秒分段定位。` : '需先配置 DeepSeek API Key 才能进行无字幕语音识别。'}</p></div>
          {platformId !== 'pokercoaching' && <div className="tool-row"><span>{status?.mediaToolReady ? '视频提取工具已就绪' : '首次使用需安装视频提取工具'}</span><button type="button" className="small-button" disabled={!!busy || !!status?.activeTaskId} onClick={() => action('install-media', async () => { const result = await api<{ message: string }>('/tools/media/install', {}); setNotice({ text: result.message, error: false }); })}>{busy === 'install-media' ? <LoaderCircle size={14} className="spin" /> : <Settings2 size={14} />}{busy === 'install-media' ? '安装中…' : status?.mediaToolReady ? '更新提取工具' : '安装提取工具'}</button></div>}
          <div className="connection-row"><div><span className={`connection-dot ${sessionSaved ? 'connected' : ''}`} /><strong>{sessionSaved ? `${platformLabel(platformId)} 会话已保存` : `${platformLabel(platformId)} 未保存登录状态`}</strong><span>{platformId === 'pokercoaching' ? '需使用本人课程账号登录' : '公开视频通常无需登录，遇到验证时再连接账号'}</span></div><div className="connection-actions"><button type="button" className="small-button" disabled={!!busy} onClick={() => login()}><LogIn size={14} />{busy === 'login' ? '正在打开…' : '打开登录窗口'}</button><button type="button" className="small-button" disabled={!!busy || !status?.browserConnected} onClick={() => login(true)}><Check size={14} />{busy === 'capture' ? '正在保存…' : '确认已登录'}</button></div></div>
        </section>}

        <div className="workspace-grid">
          <section className="task-panel panel" aria-label="任务列表"><div className="list-heading"><h2>{view === 'history' ? '全部任务' : '最近任务'}</h2><span>{tasks.length}</span></div>
            {visibleTasks.length ? <div className="task-list">{visibleTasks.map(item => <button key={item.id} className={`task-item ${item.id === selected ? 'selected' : ''}`} onClick={() => choose(item.id)}><div className="task-item-top"><span className={`status-badge ${item.status}`}>{isActive(item) ? <LoaderCircle size={11} className="spin" /> : item.status === 'completed' ? <Check size={11} /> : null}{statusLabels[item.status]}</span><span className="task-date">{date(item.createdAt)}</span></div><strong>{item.title === '等待识别课程' ? item.url.split('/').filter(Boolean).at(-1)?.replaceAll('-', ' ') : item.title}</strong><div className="task-bottom"><FileText size={12} /><span>{item.source === 'sample' ? '已验证素材' : platformLabel(item.platform || inferPlatform(item.url) || undefined)}</span>{item.result && <span>{time(item.result.duration)}</span>}</div>{isActive(item) && <div className="mini-progress"><i style={{ width: `${item.progress}%` }} /></div>}</button>)}</div> : <div className="empty-list"><FileText size={25} strokeWidth={1.4} /><p>还没有学习笔记</p><span>提交链接后，任务会保存在这里。</span></div>}
            {status?.sampleAvailable && <div className="sample-block"><strong>先体验一份真实课程素材</strong><p>使用此前已完整验证的音频、字幕和截图，按上方所选模型生成笔记。</p><button className="sample-button" disabled={!!busy || !canRun} onClick={() => create(true)}>{busy === 'sample' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}用已验证素材体验</button></div>}
          </section>

          <section className="result-panel panel" aria-label="学习笔记预览">
            {!task ? <div className="empty-result"><div className="empty-illustration"><span className="paper back" /><span className="paper front"><FileText size={39} strokeWidth={1.3} /><i /><i /><i /></span><span className="paper-check"><Check size={18} /></span></div><span className="eyebrow">YOUR NEXT LEARNING NOTE</span><h2>让一节课，留下清晰的笔记</h2><p>粘贴课程链接，或选择左侧的已验证素材。<br />完成后，在这里预览、复习和下载。</p><div className="output-features"><span><Captions size={17} />时间戳字幕</span><span><ImageIcon size={17} />画面与文字</span><span><FileText size={17} />Markdown 笔记</span></div><div className="empty-mode">{selection.providerId === 'local' ? '当前模式：本地提取式整理，不调用大模型' : `当前选择：${selectedProvider?.label || 'DeepSeek'}，${canRun ? '已配置，可生成语义笔记' : '请先配置密钥'}`}</div></div> : <>
              <div className="result-header"><div><span className="eyebrow">LEARNING NOTE</span><h2>{task.title}</h2><a href={task.url} target="_blank" rel="noreferrer">{platformLabel(task.platform || inferPlatform(task.url) || undefined)} · 查看原视频</a></div><span className={`status-badge ${task.status}`}>{statusLabels[task.status]}</span></div>
              {task.result && <div className="model-result-row"><div><strong>{task.result.noteMode === 'model-semantic' ? `模型语义总结 · ${task.result.model?.providerLabel} / ${task.result.model?.modelLabel}` : '本地原文整理'}</strong>{task.result.aiError && <p>部分步骤未完成，已保留可用产物：{task.result.aiError}</p>}</div><button className="small-button" disabled={!!busy || !canRun} onClick={() => action('regenerate', async () => { const next = await api<Task>(`/tasks/${task.id}/regenerate`, { options: currentOptions }); choose(next.id); })}><RotateCcw size={14} />{busy === 'regenerate' ? '正在创建…' : selection.providerId === 'local' ? '用本地方式重新整理' : '重新整理并生成讲稿'}</button></div>}
              {task.result && <div className="refinement-panel"><div><strong>重点提炼</strong><p>{refinementBusy ? task.refinement?.message : task.refinement?.message || '用现有完整 Markdown 生成视频重点和精简讲稿，合并重复并保留关键事实。'}</p>{refinementBusy && <progress max={100} value={task.refinement?.progress || 0} />}</div><div className="refinement-actions"><button className="small-button" disabled={!!busy || isActive(task) || refinementBusy || !canRefine} onClick={() => generateRefinements('both', documents.includes('视频重点.md') && documents.includes('精简讲稿.md'))}>{refinementBusy ? '正在提炼…' : documents.includes('视频重点.md') && documents.includes('精简讲稿.md') ? '重新提炼两份文档' : '生成重点版'}</button>{refinementBusy && task.refinement?.jobId && <button className="text-button" disabled={!!busy || task.refinement.status === 'cancelling'} onClick={() => action('cancel-refinement', async () => { await api(`/tasks/${task.id}/refine/cancel`, {}); })}>取消精简</button>}</div></div>}
              {isActive(task) && <div className="progress-card" role="status"><div className="progress-title"><span><LoaderCircle className="spin" size={17} />{task.message}</span><strong>{task.progress}%</strong></div><div className="progress-track"><i style={{ width: `${task.progress}%` }} /></div><div className="stage-list">{stages.map((stage, index) => <span key={stage.key} className={index < stageIndex ? 'done' : index === stageIndex ? 'current' : ''}>{index < stageIndex ? <Check size={13} /> : <stage.icon size={13} />}{stage.label}</span>)}</div><div className="progress-foot"><span>{task.duration ? `${task.platform && task.platform !== 'pokercoaching' ? time(task.duration) : `${time(task.elapsed)} / ${time(task.duration)}`} · ` : ''}{task.stage === 'ocr' ? 'OCR 逐张保存，可续跑；超时会跳过 OCR 并保留原图分析' : task.stage === 'summarizing' ? '复用已完成步骤，正在处理未完成的信息与讲稿' : task.platform && task.platform !== 'pokercoaching' ? '下载并解析中，耗时取决于网络与视频长度' : '连续播放提取，耗时约等于视频时长'}</span><button disabled={task.status === 'cancelling' || !!busy} className="text-button" onClick={() => action('cancel', async () => { await api(`/tasks/${task.id}/cancel`, {}); })}><Square size={11} />取消任务</button></div></div>}
              {task.status === 'failed' || task.status === 'cancelled' ? <div className="failure-card"><CircleAlert size={27} /><h3>{task.status === 'cancelled' ? '这次任务已取消' : '这次处理未完成'}</h3><p>{task.message}</p><button className="secondary" disabled={!!busy} onClick={() => action('retry', async () => { const next = await api<Task>(`/tasks/${task.id}/retry`, {}); choose(next.id); })}><RotateCcw size={16} />重试任务</button></div> : null}
              {(task.analysis || task.result?.analysis) && <div className="analysis-coverage" role="status">{(() => { const value = task.analysis || task.result!.analysis!; return <><strong>{value.enabled ? '全量图片分析' : '图片分析已关闭'}</strong><span>已分析 {value.analyzed} / {value.total} 张 · 批次 {value.completedBatches} / {value.batches} · 失败 {value.failedBatches} 批（{value.failed} 张）</span>{(value.failedBatches > 0 || task.result?.aiError) && !isActive(task) && <button className="small-button" disabled={!!busy} onClick={() => action('retry-batches', async () => { const next = await api<Task>(`/tasks/${task.id}/retry`, {}); choose(next.id); })}><RotateCcw size={14} />{value.failedBatches ? '重试失败批次' : '继续教学分析'}</button>}{!!(value.errors || artifacts?.errors)?.length && <details className="batch-errors"><summary>查看具体失败原因</summary><ul>{(value.errors || artifacts?.errors || []).map((error, index) => <li key={index}>第 {error.batch} 批 · {error.stage}{error.imageCount ? `（${error.imageCount} 张）` : ''}：{error.message}</li>)}</ul></details>}</>; })()}</div>}
              {task.result ? <>
                <div className="result-stats"><span><Clock3 size={15} /><strong>{time(task.result.duration)}</strong>视频时长</span><span><Captions size={15} /><strong>{task.result.cueCount}</strong>{Object.values(task.result.captionSources || {}).some(source => source.kind === 'asr') ? '段转写' : '条字幕'}</span><span><ImageIcon size={15} /><strong>{task.result.frameCount}</strong>张画面</span><span className={task.result.fullPlayback ? 'coverage full' : 'coverage'}><CircleCheck size={14} />{task.result.fullPlayback ? task.result.validationMethod === 'download-duration' ? '完整提取已验证' : '完整播放已验证' : `仅覆盖 ${time(task.result.coveredSeconds)}`}</span></div>
                <div className="result-toolbar"><div className="tabs" role="tablist">{[['note', '视频信息整理'], ['video-summary', '视频重点'], ['script', '教学讲稿'], ['script-summary', '精简讲稿'], ['frames', '关键图片'], ['allframes', '全部截图'], ['details', '任务详情']].map(([key, label]) => <button role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}>{label}</button>)}</div><div className="download-actions">{['note', 'script', 'video-summary', 'script-summary'].includes(tab) && (tab === 'note' || documents.includes(documentFile)) && <a className="icon-button" title={`下载${documentFile}`} aria-label={`下载${documentFile}`} href={fileUrl(task.id, documentFile, true)}><Download size={16} /><span>MD</span></a>}<a className="small-primary" href={`/api/tasks/${task.id}/archive`}><FolderDown size={15} />完整文件包</a></div></div>
                {['note', 'script', 'video-summary', 'script-summary'].includes(tab) && <div className="note-content">{noteLoading ? <div className="loading-note"><LoaderCircle className="spin" size={20} />正在读取{documentFile}…</div> : noteError ? <div className="document-empty" role="alert">{noteError}</div> : note ? <>{refinedKind && <div className="document-status"><p>{refinedOutput?.stale ? '源文档已变化，当前精简版已过期，请重新提炼。' : '大模型基于现有 Markdown 去重提炼；完整版本仍保留。'}</p>{refinedOutput?.available && refinedOutput.status !== 'completed' && <p>当前展示上一次成功文件，新一轮提炼尚未完成。</p>}{refinedOutput?.error && <p>本次提炼提示：{refinedOutput.error}</p>}{refinedOutput?.sourcePartial && <p>源文档为部分内容或历史草稿，本精简版不代表完整视频。</p>}{refinedOutput?.inputChars && <p>原文约 {refinedOutput.inputChars.toLocaleString()} 字符 → 精简 {refinedOutput.outputChars?.toLocaleString()} 字符</p>}<button className="small-button" disabled={!!busy || isActive(task) || refinementBusy || !canRefine} onClick={() => generateRefinements(refinedKind, true)}>重新提炼本页</button></div>}{tab === 'script' && artifacts?.artifactStatus?.lesson === 'partial' && <p className="document-status">当前为部分讲稿 / 历史草稿，未覆盖全片。可继续生成或重新整理补齐。</p>}<Markdown value={note} id={task.id} /></> : refinedKind ? <div className="document-empty"><h3>{refinedKind === 'video' ? '视频重点' : '精简讲稿'}尚未生成</h3><p>{refinedOutput?.sourceMissing ? '对应完整 Markdown 尚未生成，请先完成相应完整文档。' : refinedOutput?.error || '读取当前任务已有的完整 Markdown，发送给模型去重提炼，不会重新处理视频、OCR 或图片。'}</p><button className="small-primary" disabled={!!busy || isActive(task) || refinementBusy || !canRefine || refinedOutput?.sourceMissing} onClick={() => generateRefinements(refinedKind)}>{refinementBusy ? '正在提炼…' : '生成本页精简版'}</button>{!canRefine && <p>请在上方选择外部模型并配置 API Key。</p>}</div> : <div className="document-empty"><h3>教学讲稿尚未生成</h3><p>{task.result.aiError ? '部分分析或讲稿步骤未完成，已有图文信息和图片仍可查看。请点击“继续教学分析”或“重试失败批次”。' : task.result.noteMode === 'local-extractive' ? '本任务采用本地文字整理，未调用模型生成讲稿。请在上方选择模型，再点击“重新整理并生成讲稿”。' : '这是旧任务或尚无独立讲稿文件。请点击“重新整理并生成讲稿”，使用已有素材生成新版产物。'}</p></div>}</div>}
                {(tab === 'frames' || tab === 'allframes') && <><p className="gallery-description">{tab === 'frames' ? keyFrames.length ? '模型筛选并保守去重的关键图片，按视频顺序排列。点击图片可放大查看。' : '本任务尚无模型筛选的关键图片。可查看全部截图，或选择支持图片的模型重新分析。' : '保留全部采样原图供核对；截图密度改变后，公开视频将从已下载源文件重新采样。'}</p><div className="frames-grid">{[...(tab === 'frames' ? keyFrames : task.result.frames)].sort((a, b) => a.time - b.time).map(frame => <figure key={frame.file}><a href={fileUrl(task.id, frame.keyFile || frame.file)} target="_blank" rel="noreferrer"><img src={fileUrl(task.id, frame.keyFile || frame.file)} alt={frame.description || `${time(frame.time)} 视频画面`} loading="lazy" /></a><figcaption><strong>{time(frame.time)}</strong><span>{tab === 'frames' ? '关键图片' : `OCR ${Math.round(frame.confidence)}%`}</span></figcaption>{frame.description && <p>{frame.description}</p>}{frame.reason && <p>保留原因：{frame.reason}</p>}<div className="frame-information">{frame.background && <p><strong>场景与牌局背景：</strong>{frame.background}</p>}{frame.visualFacts?.length ? <div><h4>画面可见事实</h4><ul>{frame.visualFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></div> : null}{frame.state && <dl>{Object.entries(frame.state).map(([key, value]) => <React.Fragment key={key}><dt>{frameLabels[key] || key}</dt><dd>{value}</dd></React.Fragment>)}</dl>}{frame.streetTimeline?.length ? <div><h4>逐街过程（画面回顾）</h4>{frame.streetTimeline.map((street, index) => <section className="street-information" key={index}><strong>{street.street}</strong><p>{street.players} · {street.board}</p><p>{street.actions}</p><p>数额：{street.amounts}</p><p>{street.commentary}（{street.sourceType}）</p></section>)}</div> : null}{frame.teachingMeaning && <p><strong>教学意义：</strong>{frame.teachingMeaning}</p>}{frame.uncertainties?.length ? <ul>{frame.uncertainties.map((item, index) => <li key={index}>待核对：{item}</li>)}</ul> : null}</div><pre>{frame.text || '本图没有 OCR 文字。'}</pre></figure>)}</div></>}
                {tab === 'details' && <div className="details-content"><h3>处理信息</h3><dl><dt>产物目录</dt><dd>{task.outputDirectory || task.id}</dd><dt>来源平台</dt><dd>{platformLabel(task.result.platform || task.platform || inferPlatform(task.url) || undefined)}</dd><dt>处理方式</dt><dd>{task.result.noteMode === 'model-semantic' ? '模型语义总结 + 本地 OCR' : '本地字幕提取式整理 + OCR'}</dd><dt>实际模型</dt><dd>{task.result.model ? `${task.result.model.providerLabel} / ${task.result.model.modelId}` : '未调用模型'}</dd><dt>请求模型</dt><dd>{task.model ? `${task.model.providerLabel} / ${task.model.modelId}` : '本地整理'}</dd><dt>素材来源</dt><dd>{task.source === 'sample' ? '此前实际验证的课程素材，未重新播放' : '本次视频提取'}</dd><dt>创建时间</dt><dd>{date(task.createdAt)}</dd><dt>字幕语言</dt><dd>{task.result.language || '未获取'}</dd><dt>转录来源</dt><dd>{Object.values(task.result.captionSources || {}).some(source => source.kind === 'asr') ? '语音识别，按音频分段定位' : '站点字幕'}</dd><dt>截图间隔</dt><dd>{task.options.frameInterval} 秒{task.source === 'sample' ? '（素材体验使用已有截图）' : ''}</dd></dl><div className="detail-downloads">{documents.filter(file => !['学习笔记.md', '视频解析.md'].includes(file)).map(file => <a key={file} href={fileUrl(task.id, file, true)}><FileText size={16} />下载 {file}</a>)}{task.result.documents?.length ? <><a href={fileUrl(task.id, '教学分镜.json', true)}>下载教学分镜 JSON</a><a href={fileUrl(task.id, '关键图片.json', true)}>下载关键图片索引</a></> : null}{task.result.analysis && <a href={fileUrl(task.id, 'analysis-progress.json', true)}>下载分析覆盖记录</a>}<a href={fileUrl(task.id, '完整转录.md', true)}><FileText size={16} />下载完整转录</a>{task.result.hasAudio && <a href={fileUrl(task.id, 'audio.wav', true)}><Download size={16} />下载音频 WAV</a>}{Object.entries(task.result.captions).map(([language, file]) => <a key={language} href={fileUrl(task.id, file, true)}><Captions size={16} />下载 {language} 字幕</a>)}</div><h3>完整性与待核实项</h3>{task.result.warnings.length ? <ul>{task.result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : <p>播放范围已完整验证。OCR、数字及牌面信息仍需结合原画面核对。</p>}<p className="detail-note">{task.result.noteMode === 'model-semantic' ? '模型根据所选字幕和画面材料进行归纳，原始转录与截图仍保留，牌面和数字需回看核对。' : '本地模式整理字幕原文，不进行模型语义总结。缺失字幕时，会保留音频和画面并标记内容不完整。'}</p></div>}
              </> : isActive(task) ? <div className="processing-placeholder"><Layers3 size={36} strokeWidth={1.2} /><h3>正在为这节课整理素材</h3><p>你可以继续提交链接，任务将依次处理。</p></div> : null}
            </>}
          </section>
        </div>
        <footer className="page-footer"><span>Poker Notes · 让复习更有依据</span><span>{activeTask ? activeTask.refinement?.jobId && !isActive(activeTask) ? '正在提炼现有文档，请保持本地服务运行' : '有任务正在本地处理，请保持服务与登录窗口开启' : '学习资料保存在本机'}</span></footer>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
