import express from 'express';
import { createServer } from 'node:http';
import { fork, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { ROOT, LOCAL, getTask, listTasks, saveTask, patchTask, normalizeUrl, taskDirectory, safeOutputPath } from './store.mjs';
import { browserReady } from './acquire.mjs';
import { modelCatalog, savePreference, saveCredential, snapshotModel, snapshotSpeech, callModel } from './models.mjs';
import { PLATFORMS, parseVideoUrl, platformInfo } from './platforms.mjs';
import { mediaToolReady } from './public-media.mjs';
import { installMediaTool } from '../scripts/install-media-tools.mjs';
import { createTaskRunner, readCompletion } from './task-runner.mjs';
import { taskArtifacts, restoreSavedArtifacts } from './artifacts.mjs';

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 3210);
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.status(403).json({ error: '只允许本机访问' });
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return res.status(403).json({ error: '不允许跨站请求' });
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: '请求必须使用 JSON' });
  }
  next();
});
app.use(express.json({ limit: '32kb' }));

const sampleUrl = 'https://pokercoaching.com/courses/complete-cash-game-system/welcome-to-the-complete-cash-game-system/';
const samplePath = path.join(ROOT, 'artifacts/continuous-verification/welcome-to-the-complete-cash-game-system/summary.json');
const doneStatuses = ['completed', 'partial', 'failed', 'cancelled'];

// A previous process cannot resume a live MediaRecorder. Keep the task and offer retry.
for (const task of listTasks()) {
  if (['running', 'cancelling'].includes(task.status)) {
    const saved = await readCompletion(taskDirectory(task.id));
    if (saved) patchTask(task.id, saved);
    else if (task.status === 'cancelling') patchTask(task.id, { status: 'cancelled', stage: 'cancelled', message: '取消已生效，保存进度仍可复用。' });
    else if (existsSync(path.join(taskDirectory(task.id), 'acquisition.json'))) patchTask(task.id, { status: 'queued', cacheId: task.id, message: '服务重启后从保存进度继续' });
    else patchTask(task.id, { status: 'failed', stage: 'failed', message: '提取曾中断，尚无完整媒体，可重试。' });
  }
}
for (const task of listTasks()) {
  try { await restoreSavedArtifacts(task); }
  catch { console.error(`任务 ${task.id} 的已有产物恢复未完成，可通过重新整理重试。`); }
}
const runner = createTaskRunner({ listTasks, getTask, patchTask, spawnWorker: () => fork(path.join(ROOT, 'server/worker.mjs'), [], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }), recover: id => readCompletion(taskDirectory(id)), log: text => console.error(text) });
const schedule = () => runner.schedule();
async function createTask(input) {
  const frameInterval = Number(input.options?.frameInterval ?? 5);
  if (!Number.isFinite(frameInterval) || frameInterval < 3 || frameInterval > 120) throw new Error('截图间隔需在 3–120 秒之间');
  const selection = input.options?.modelSelection || (await modelCatalog()).defaultSelection;
  const model = await snapshotModel(selection);
  if (input.options?.includeImages !== false && model && !model.vision) throw new Error('所选模型不支持图片，请选择支持图片的模型，或明确关闭图片分析');
  const video = parseVideoUrl(input.url);
  const speech = input.options?.transcribe === true ? await snapshotSpeech(input.options?.speechProviderId || 'deepseek') : null;
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), url: video.url, platform: video.platform, source: input.source === 'sample' ? 'sample' : 'url',
    title: '等待识别课程', status: 'queued', stage: 'queued', progress: 0, message: '等待处理',
    options: { ocr: input.options?.ocr !== false, frameInterval, modelSelection: { providerId: selection.providerId, modelId: selection.modelId }, includeImages: input.options?.includeImages !== false, transcribe: !!speech, speechProviderId: speech?.providerId || null },
    model, speech,
    createdAt: now, updatedAt: now, ...(input.cacheId ? { cacheId: input.cacheId } : {}),
  };
  saveTask(task); schedule(); return getTask(task.id);
}
function requireTask(req, res, next) {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  req.task = task; next();
}
function command(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: ROOT, windowsHide: true });
    let error = '';
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error.includes('ECONNREFUSED') ? '登录窗口未连接，请先打开登录窗口' : '操作未完成，请检查登录窗口后重试')));
  });
}
app.get('/api/status', async (_req, res) => res.json({ browserConnected: await browserReady(), sessionSaved: existsSync(path.join(LOCAL, 'auth.json')), platformSessions: Object.fromEntries(PLATFORMS.map(platform => [platform.id, existsSync(path.join(LOCAL, 'platform-cookies', `${platform.id}.txt`)) || platform.id === 'pokercoaching' && existsSync(path.join(LOCAL, 'auth.json'))])), mediaToolReady: mediaToolReady(), sampleAvailable: existsSync(samplePath), activeTaskId: runner.active?.id ?? null, mode: 'configurable' }));
app.get('/api/platforms', (_req, res) => res.json(PLATFORMS.map(({ domains, ...platform }) => platform)));
app.post('/api/tools/media/install', async (_req, res, next) => {
  try {
    if (runner.active) return res.status(409).json({ error: '请等待当前任务结束后更新提取工具' });
    res.json(await installMediaTool());
  } catch (error) { next(error); }
});
app.get('/api/models', async (_req, res, next) => { try { res.json(await modelCatalog()); } catch (error) { next(error); } });
app.post('/api/models/preferences', async (req, res, next) => {
  try { await savePreference(req.body.selection); res.json(await modelCatalog()); } catch (error) { next(error); }
});
app.post('/api/models/credentials', async (req, res, next) => {
  try { await saveCredential(req.body.providerId, req.body); res.json(await modelCatalog()); } catch (error) { next(error); }
});
app.post('/api/models/test', async (req, res, next) => {
  try {
    const snapshot = await snapshotModel(req.body.selection);
    if (!snapshot) throw new Error('本地整理无需测试模型连接');
    await callModel(snapshot, [{ role: 'user', content: '请只回复：连接成功。' }], { maxTokens: 256 });
    res.json({ message: `${snapshot.providerLabel} / ${snapshot.modelLabel} 连接成功` });
  } catch (error) { next(error); }
});
app.post('/api/login/open', async (req, res, next) => {
  try {
    const platform = req.body.platform || 'pokercoaching';
    platformInfo(platform);
    await command('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'scripts/open-login-browser.ps1'), '-Platform', platform]);
    res.json({ message: '登录窗口已打开。请手动登录，再点击“确认已登录”。' });
  } catch (error) { next(error); }
});
app.post('/api/login/capture', async (req, res, next) => {
  try { const platform = req.body.platform || 'pokercoaching'; platformInfo(platform); await command(process.execPath, [path.join(ROOT, 'scripts/capture-site-session.mjs'), platform]); res.json({ message: `${platformInfo(platform).label} 会话已保存。具体视频权限将在处理时检查。` }); }
  catch (error) { next(error); }
});
app.get('/api/tasks', (_req, res) => res.json(listTasks()));
app.post('/api/tasks', async (req, res, next) => { try { res.status(201).json(await createTask({ ...req.body, source: 'url', cacheId: undefined })); } catch (error) { next(error); } });
app.post('/api/tasks/sample', async (req, res, next) => {
  try {
    if (!existsSync(samplePath)) return res.status(404).json({ error: '本机没有已验证素材，请提交课程地址创建任务。' });
    res.status(201).json(await createTask({ url: sampleUrl, source: 'sample', options: req.body.options }));
  } catch (error) { next(error); }
});
app.get('/api/tasks/:id', requireTask, (req, res) => res.json(req.task));
app.get('/api/tasks/:id/artifacts', requireTask, async (req, res, next) => {
  try { res.json(await taskArtifacts(req.task)); } catch (error) { next(error); }
});
app.post('/api/tasks/:id/cancel', requireTask, (req, res) => {
  runner.cancel(req.task.id); res.json(getTask(req.task.id));
});
app.post('/api/tasks/:id/retry', requireTask, async (req, res, next) => {
  try {
    if (!doneStatuses.includes(req.task.status)) return res.status(409).json({ error: '任务仍在处理中' });
    const cacheId = existsSync(path.join(taskDirectory(req.task.id), 'acquisition.json')) ? req.task.id : undefined;
    res.status(201).json(await createTask({ ...req.task, options: { ...req.task.options, modelSelection: req.task.options.modelSelection || { providerId: 'local', modelId: 'local' } }, cacheId }));
  } catch (error) { next(error); }
});
app.post('/api/tasks/:id/regenerate', requireTask, async (req, res, next) => {
  try {
    if (!doneStatuses.includes(req.task.status)) return res.status(409).json({ error: '原任务仍在处理中' });
    if (!existsSync(path.join(taskDirectory(req.task.id), 'acquisition.json'))) return res.status(409).json({ error: '没有可复用的提取素材，请先重新提取课程' });
    res.status(201).json(await createTask({ url: req.task.url, source: req.task.source, cacheId: req.task.id, options: { ...req.task.options, ...req.body.options } }));
  } catch (error) { next(error); }
});
app.get('/api/tasks/:id/note', requireTask, async (req, res) => {
  try { const directory = taskDirectory(req.task.id); const name = existsSync(path.join(directory, '视频信息整理.md')) ? '视频信息整理.md' : '学习笔记.md'; res.type('text/plain; charset=utf-8').send(await readFile(path.join(directory, name), 'utf8')); }
  catch { res.status(404).json({ error: '笔记尚未生成' }); }
});
const allowedFile = file => ['学习笔记.md', '本地整理.md', '完整转录.md', 'audio.wav', '视频信息整理.md', '产物状态.json', 'keyframes/说明.md', '视频解析.md', '教学讲稿.md', '关键图片.json', 'analysis-progress.json', '教学分镜.json'].includes(file) || /^((?:images|keyframes)\/frame-\d+\.png|captions\/(zh|en)\.vtt)$/.test(file);
app.get('/api/tasks/:id/file', requireTask, (req, res, next) => {
  try {
    const file = req.query.path;
    if (!allowedFile(file)) return res.status(404).json({ error: '文件不存在' });
    const target = safeOutputPath(req.task.id, file);
    if (!existsSync(target)) return res.status(404).json({ error: '文件尚未生成' });
    if (req.query.download === '1') res.download(target, path.basename(file));
    else res.sendFile(target);
  } catch (error) { next(error); }
});
app.get('/api/tasks/:id/archive', requireTask, async (req, res, next) => {
  try {
    if (!req.task.result) return res.status(409).json({ error: '笔记尚未生成' });
    res.attachment('学习笔记.zip');
    const archive = new ZipArchive({ zlib: { level: 5 } });
    archive.on('error', error => { if (!res.headersSent) next(error); else res.destroy(error); });
    res.on('close', () => archive.abort());
    archive.pipe(res);
    const directory = taskDirectory(req.task.id);
    for (const name of ['视频信息整理.md', '学习笔记.md', '本地整理.md', '完整转录.md', '视频解析.md', '教学讲稿.md', '关键图片.json', '教学分镜.json', 'analysis-progress.json', '产物状态.json']) if (existsSync(path.join(directory, name))) archive.file(path.join(directory, name), { name });
    for (const folder of ['images', 'captions', 'keyframes']) if (existsSync(path.join(directory, folder))) archive.directory(path.join(directory, folder), folder);
    await archive.finalize();
  } catch (error) { next(error); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message || '操作失败' }));

if (process.argv.includes('--dev')) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ configFile: path.join(ROOT, 'vite.config.ts'), server: { middlewareMode: true, hmr: { server } } });
  app.use(vite.middlewares);
} else {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
server.listen(port, '127.0.0.1', () => { console.log(`Video2Note: http://127.0.0.1:${server.address().port}`); schedule(); });
