import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { analyzePlayback, wavDuration } from '../scripts/playback-analysis.mjs';
import { ROOT, LOCAL } from './store.mjs';
import { parseVtt } from './notes.mjs';
import { normalizeSubtitleEncoding } from './captions.mjs';
import { parseVideoUrl } from './platforms.mjs';
import { acquirePublic } from './public-media.mjs';

export async function browserReady() {
  try { const response = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; }
}
async function convertAudio(directory) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(directory, 'audio.webm'), '-ac', '1', '-ar', '16000', path.join(directory, 'audio.wav')], { windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`音频转换失败：${error.slice(-300)}`)));
  });
}
const vttTime = seconds => {
  const n = Math.max(0, seconds);
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${(n % 60).toFixed(3).padStart(6, '0')}`;
};
export async function acquire(task, directory, report, checkCancelled) {
  if (parseVideoUrl(task.url).platform !== 'pokercoaching') return acquirePublic(task, directory, report, checkCancelled);
  const connected = await browserReady();
  if (!connected && !existsSync(path.join(LOCAL, 'auth.json'))) throw new Error('请先在网页中打开登录窗口，完成登录后点击“确认已登录”。');
  let browser, page;
  const captions = new Map(), access = [], pending = new Set();
  const frames = [], observations = [], warnings = [];
  let recordingStart = 0;
  await mkdir(path.join(directory, 'images'), { recursive: true });
  await mkdir(path.join(directory, 'captions'), { recursive: true });
  try {
    browser = connected ? await chromium.connectOverCDP('http://127.0.0.1:9223') : await chromium.launch({ channel: 'chrome', headless: true });
    const context = connected ? browser.contexts()[0] : await browser.newContext({ storageState: path.join(LOCAL, 'auth.json'), viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on('response', response => {
      const promise = (async () => {
        const parsed = new URL(response.url());
        if (/^\/api\/get-topic(?:-wp)?\/$/.test(parsed.pathname)) {
          const json = await response.json();
          const data = json.data ?? json;
          access.push({ endpoint: parsed.pathname, hasAccess: data.has_access ?? null, title: data.title });
        }
        if (parsed.hostname === 'video-cdn.pokercoaching.com' && response.ok() && /\.(zh|en)\.vtt$/.test(parsed.pathname)) {
          captions.set(parsed.pathname.endsWith('.zh.vtt') ? 'zh' : 'en', normalizeSubtitleEncoding((await response.body()).toString('utf8')));
        }
      })().catch(() => {}).finally(() => pending.delete(promise));
      pending.add(promise);
    });
    report({ stage: 'inspecting', progress: 5, message: '正在加载课程，检查播放器与登录状态' });
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    checkCancelled();
    try { await page.getByRole('button', { name: 'Play Video', exact: true }).waitFor({ state: 'visible', timeout: 45000 }); }
    catch { throw new Error('未找到可播放的视频。请检查登录状态、课程权限，或确认地址是单个视频页面。'); }
    const body = await page.locator('body').innerText();
    if (body.includes('Ready to Start Crushing?') || body.includes('Upgrade to PREMIUM')) throw new Error('当前页面提示登录或升级，无法开始正常播放。请检查此账号的课程权限。');
    const title = (await page.title()).replace(/\s*-\s*PokerCoaching(?:\.com)?\s*$/i, '');
    report({ title, stage: 'playing', progress: 10, message: '正在从头播放并提取音频、字幕和画面' });
    await page.getByRole('button', { name: 'Play Video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0, null, { timeout: 30000 });
    recordingStart = await page.locator('video').evaluate(video => {
      if (video.currentTime > 3) throw new Error('视频从上次位置继续播放，请在课程播放器中回到开头后重试。');
      const tracks = video.captureStream().getAudioTracks();
      if (!tracks.length) throw new Error('播放器没有可提取的音轨');
      const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('音频录取失败'));
      });
      window.__pokerNotesRecorder = { recorder, chunks, done };
      recorder.start(1000);
      return video.currentTime;
    });
    const started = Date.now();
    const duration = await page.locator('video').evaluate(video => video.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
    let nextFrame = 0;
    let lastAdvance = Date.now(), lastTime = 0;
    let stopReason = 'timeout';
    while (Date.now() - started < (duration + 180) * 1000) {
      checkCancelled();
      const state = await page.evaluate(() => {
        const video = document.querySelector('video');
        return { currentTime: video?.currentTime ?? 0, duration: video?.duration, ended: video?.ended ?? false, visible: !!video?.getClientRects().length, upgradePrompt: document.body.innerText.includes('Upgrade to PREMIUM'), error: video?.error?.message ?? null };
      });
      observations.push({ elapsed: (Date.now() - started) / 1000, ...state });
      if (state.currentTime > lastTime + 0.5) { lastAdvance = Date.now(); lastTime = state.currentTime; }
      report({ stage: 'playing', duration, elapsed: state.currentTime, progress: 10 + Math.round(Math.min(state.currentTime / duration, 1) * 60), frameCount: frames.length, message: `正在播放提取 ${Math.floor(state.currentTime)} / ${Math.ceil(duration)} 秒` });
      if (state.visible && !state.upgradePrompt && state.currentTime >= nextFrame) {
        const image = await page.locator('video').evaluate(video => {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          return { png: canvas.toDataURL('image/png').split(',')[1] };
        });
        const file = `images/frame-${String(frames.length + 1).padStart(3, '0')}.png`;
        await writeFile(path.join(directory, file), Buffer.from(image.png, 'base64'));
        frames.push({ file, time: state.currentTime });
        nextFrame = state.currentTime + task.options.frameInterval;
      }
      if (state.ended) { stopReason = 'ended'; break; }
      if (!state.visible || state.upgradePrompt) { stopReason = 'access-prompt'; break; }
      if (state.error) { stopReason = 'media-error'; break; }
      if (Date.now() - lastAdvance > 60000) { stopReason = 'stalled'; break; }
      await page.waitForTimeout(250);
    }
    checkCancelled();
    const encoded = await page.evaluate(async () => {
      const { recorder, chunks, done } = window.__pokerNotesRecorder;
      if (recorder.state !== 'inactive') recorder.stop();
      await done;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    });
    await writeFile(path.join(directory, 'audio.webm'), Buffer.from(encoded, 'base64'));
    report({ stage: 'extracting', progress: 72, message: '正在转换音频并校验内容完整性' });
    await convertAudio(directory);
    const recordedAudioSeconds = await wavDuration(path.join(directory, 'audio.wav'));
    await Promise.all([...pending]);
    const finalDuration = observations.at(-1)?.duration ?? duration;
    const analysis = analyzePlayback({ observations, duration: finalDuration, recordingStart }, recordedAudioSeconds);
    const fullPlayback = analysis.status === 'full-playback-verified';
    const coveredSeconds = fullPlayback ? finalDuration : Math.min(recordingStart + recordedAudioSeconds, finalDuration);
    if (!fullPlayback) warnings.push(`仅获取约 ${Math.round(coveredSeconds)} 秒 / 总长 ${Math.round(finalDuration)} 秒。停止原因：${stopReason}；未将跳到片尾或试看结束视为完整播放。`);
    if (!fullPlayback && observations.at(-1)?.upgradePrompt) warnings.push('页面出现升级提示，请使用拥有该课程完整权限的账号。');
    const captionFiles = {};
    for (const [language, content] of captions) {
      const file = `captions/${language}.vtt`;
      const cropped = fullPlayback ? content : `WEBVTT\n\n${parseVtt(content).filter(cue => cue.start < coveredSeconds).map((cue, i) => `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(Math.min(cue.end, coveredSeconds))}\n${cue.text}`).join('\n\n')}\n`;
      await writeFile(path.join(directory, file), cropped);
      captionFiles[language] = file;
    }
    const media = { title, url: task.url, platform: 'pokercoaching', validationMethod: 'browser-playback', duration: finalDuration, coveredSeconds, fullPlayback, recordingStart, frameInterval: task.options.frameInterval, frames, captions: captionFiles, access, analysis, warnings };
    await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
    return media;
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
