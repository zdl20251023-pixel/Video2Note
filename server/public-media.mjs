import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { ROOT, LOCAL } from './store.mjs';
import { parseVideoUrl, platformInfo } from './platforms.mjs';
import { parseVtt } from './notes.mjs';
import { normalizeSubtitleEncoding } from './captions.mjs';
import { wavDuration } from '../scripts/playback-analysis.mjs';

export const mediaToolPath = () => process.env.YT_DLP_PATH || path.join(LOCAL, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
export const mediaToolReady = () => existsSync(mediaToolPath());
export function mediaError(platform, stderr) {
  const name = platformInfo(platform).label;
  if (/EACCES|EPERM|PermissionError|WinError 10013/i.test(stderr)) return `${name}：服务的网络访问被系统限制，请用正常网络权限启动本地工具。`;
  if (/sign in|log in|login|cookies|登录|注册/i.test(stderr)) return `${name}：该视频需要登录或验证。请在所选平台的登录窗口完成登录，并点击“确认已登录”后重试。`;
  if (/private|members.only|premium|paid|付费|会员|充电/i.test(stderr)) return `${name}：该视频有账号或付费权限限制，请确认当前账号可以完整观看。`;
  if (/not available in your country|geo.?restrict|地区|区域/i.test(stderr)) return `${name}：视频在当前网络地区不可访问。`;
  if (/429|412|403|567|rate.limit|too many requests|blocked/i.test(stderr)) return `${name}：平台暂时拒绝访问或触发访问验证。请在浏览器确认视频可播放，保存该平台登录状态后再试。`;
  if (/not found|unavailable|removed|不存在|下架/i.test(stderr)) return `${name}：视频不存在、已下架或当前不可访问。`;
  if (/timed? ?out|timeout|resolve|network|connection|SSL|certificate/i.test(stderr)) return `${name}：下载连接失败，请检查网络、代理或证书后重试。`;
  return `${name}：暂时无法提取该视频。请确认单个视频地址可播放，并尝试更新视频提取工具。`;
}
export function runProcess(command, args, { cwd = ROOT, timeout = 120000, checkCancelled = () => {}, onLine, captureLimit = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', lineBuffer = '', cancelled = false, timedOut = false, outputTooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const cancellation = setInterval(() => { try { checkCancelled(); } catch { cancelled = true; child.kill(); } }, 500);
    child.stdout.on('data', data => {
      if (!onLine) {
        stdout += data.toString('utf8');
        if (stdout.length > captureLimit) { outputTooLarge = true; child.kill(); }
      } else {
        lineBuffer += data.toString('utf8');
        const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop();
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-32000); });
    child.on('error', error => { clearTimeout(timer); clearInterval(cancellation); reject(new Error(error.code === 'ENOENT' ? '视频提取工具未安装，请先安装工具' : '无法启动媒体处理进程')); });
    child.on('close', code => {
      clearTimeout(timer); clearInterval(cancellation);
      if (cancelled) return reject(new Error('CANCELLED'));
      if (timedOut) return reject(new Error('媒体提取超时，请检查网络后重试'));
      if (outputTooLarge) return reject(new Error('平台返回数据过大，已停止提取'));
      resolve({ code, stdout, stderr });
    });
  });
}
export function selectSubtitleLanguages(info) {
  const manual = info.subtitles || {}, auto = info.automatic_captions || {};
  const keys = [...new Set([...Object.keys(manual), ...Object.keys(auto)])].filter(key => /^[A-Za-z0-9_-]{1,80}$/.test(key));
  const rank = prefix => {
    const matching = keys.filter(key => prefix === 'zh' ? /^(?:zh(?:[-_]|$)|ai-zh$)/i.test(key) : /^(?:en(?:[-_]|$)|ai-en$)/i.test(key));
    const preferred = prefix === 'zh' ? ['zh-Hans', 'zh-CN', 'zh', 'ai-zh', 'zh-Hant', 'zh-TW'] : ['en', 'en-orig', 'ai-en'];
    return matching.sort((a, b) => (manual[a]?.length ? 0 : 100) + (preferred.indexOf(a) < 0 ? 20 : preferred.indexOf(a)) - (manual[b]?.length ? 0 : 100) - (preferred.indexOf(b) < 0 ? 20 : preferred.indexOf(b)))[0];
  };
  return [['zh', rank('zh')], ['en', rank('en')]].filter(([, language]) => language).map(([alias, language]) => ({ alias, language, kind: manual[language]?.length ? 'site' : 'site-auto' }));
}
export async function acquirePublic(task, directory, report, checkCancelled) {
  const { platform, url } = parseVideoUrl(task.url);
  if (!['youtube', 'bilibili'].includes(platform)) throw new Error('公共平台适配器不支持此地址');
  if (!mediaToolReady()) throw new Error('请先点击“安装/更新提取工具”，或运行 npm.cmd run setup:media');
  const name = platformInfo(platform).label;
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(directory, 'images'), { recursive: true });
  await mkdir(path.join(directory, 'captions'), { recursive: true });
  const base = ['--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--socket-timeout', '25', '--retries', '2', '--extractor-retries', '1', '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', ffmpeg];
  const cookieFile = path.join(LOCAL, 'platform-cookies', `${platform}.txt`);
  let cookies = existsSync(cookieFile) ? ['--cookies', cookieFile] : [];
  report({ stage: 'inspecting', progress: 5, message: `正在识别 ${name} 视频、字幕和可访问画质` });
  let metadata = await runProcess(mediaToolPath(), [...base, ...cookies, '--skip-download', '--dump-single-json', url], { checkCancelled });
  if (metadata.code && cookies.length) {
    // Stale optional cookies should not prevent access to otherwise public videos.
    const anonymous = await runProcess(mediaToolPath(), [...base, '--skip-download', '--dump-single-json', url], { checkCancelled });
    if (!anonymous.code) { metadata = anonymous; cookies = []; }
  }
  if (metadata.code) throw new Error(mediaError(platform, metadata.stderr));
  let info;
  try { info = JSON.parse(metadata.stdout); } catch { throw new Error(`${name} 视频信息解析失败`); }
  if (info.is_live || info.live_status === 'is_upcoming' || info._type === 'playlist') throw new Error('本版支持已发布的单个视频，暂不支持直播、预约直播和整套播放列表');
  const duration = Number(info.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('平台未返回有效视频时长');
  const warnings = [];
  report({ title: info.title || info.id, platform, duration, stage: 'downloading', progress: 10, message: `正在下载 ${name} 可访问的视频和音轨` });
  let highest = 10;
  const downloaded = await runProcess(mediaToolPath(), [...base, ...cookies, '--no-simulate', '--no-write-info-json', '--newline', '--progress-delta', '1', '--progress-template', 'download:%(progress._percent_str)s', '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mkv', '-o', path.join(directory, 'source.%(ext)s'), url], {
    checkCancelled, timeout: 3600000,
    onLine: line => {
      const match = line.match(/([\d.]+)%/);
      if (match) {
        highest = Math.max(highest, 10 + Math.round(Number(match[1]) * 0.45));
        report({ stage: 'downloading', progress: highest, message: `正在下载视频/音轨：当前文件 ${Math.round(Number(match[1]))}%` });
      }
    },
  });
  if (downloaded.code) throw new Error(mediaError(platform, downloaded.stderr));
  checkCancelled();
  const files = await readdir(directory);
  const source = files.find(file => /^source\.(mkv|mp4|webm|flv|mov)$/.test(file));
  if (!source) throw new Error('下载已结束，但未找到完整视频文件');
  const selected = selectSubtitleLanguages(info);
  const captions = {}, captionSources = {};
  if (selected.length) {
    report({ stage: 'extracting', progress: 57, message: '正在获取站点原始/自动字幕' });
    const languages = selected.map(item => `^${item.language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).join(',');
    const subtitles = await runProcess(mediaToolPath(), [...base, ...cookies, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', languages, '--sub-format', 'vtt/best', '--convert-subs', 'vtt', '-o', path.join(directory, 'subtitles.%(ext)s'), url], { checkCancelled, timeout: 180000 });
    if (!subtitles.code) {
      for (const item of selected) {
        const sourceFile = path.join(directory, `subtitles.${item.language}.vtt`);
        if (!existsSync(sourceFile)) continue;
        const text = normalizeSubtitleEncoding(await readFile(sourceFile, 'utf8'));
        if (!parseVtt(text).length) continue;
        const relative = `captions/${item.alias}.vtt`;
        await writeFile(path.join(directory, relative), text);
        captions[item.alias] = relative; captionSources[item.alias] = { kind: item.kind, language: item.language };
      }
    }
    if (!Object.keys(captions).length) warnings.push('站点字幕未成功下载，将根据所选设置尝试语音识别。');
  }
  report({ stage: 'extracting', progress: 60, message: '正在提取音频并校验完整时长' });
  const conversion = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(directory, source), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path.join(directory, 'audio.wav')], { checkCancelled, timeout: 900000 });
  if (conversion.code) throw new Error('音频提取失败，视频可能没有可用音轨');
  const actualDuration = await wavDuration(path.join(directory, 'audio.wav'));
  const fullPlayback = Math.abs(actualDuration - duration) <= Math.max(2, duration * 0.001);
  if (!fullPlayback) warnings.push(`下载音频长度 ${Math.round(actualDuration)} 秒，与平台标注 ${Math.round(duration)} 秒不一致，结果按部分内容处理。`);
  const coveredSeconds = Math.min(actualDuration, duration);
  const frames = await extractFrames(directory, source, coveredSeconds, task.options.frameInterval, report, checkCancelled);
  if (!Object.keys(captions).length) warnings.push('该视频未获取到可用站点字幕。');
  if (Object.values(captionSources).some(source => source.kind === 'site-auto')) warnings.push('使用了站点自动字幕或自动翻译，术语和数字需要核对。');
  const media = { title: info.title || info.id, url, platform, duration, coveredSeconds, fullPlayback, validationMethod: 'download-duration', frames, captions, captionSources, warnings, frameInterval: task.options.frameInterval, sourceVideo: source, hasAudio: true };
  await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
  return media;
}

export async function extractFrames(directory, source, coveredSeconds, frameInterval, report, checkCancelled) {
  const frames = [];
  const interval = frameInterval;
  const targets = [];
  for (let time = 0; time < coveredSeconds - 0.1; time += interval) targets.push(time);
  for (let index = 0; index < targets.length; index++) {
    checkCancelled();
    const time = targets[index], file = `images/frame-${String(index + 1).padStart(3, '0')}.png`;
    report({ stage: 'extracting', progress: 62 + Math.round(index / targets.length * 10), message: `正在抽取第 ${index + 1} / ${targets.length} 张关键画面` });
    const frame = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', path.join(directory, source), '-frames:v', '1', path.join(directory, file)], { checkCancelled, timeout: 30000 });
    if (frame.code || !existsSync(path.join(directory, file))) throw new Error(`截图 ${time} 秒提取失败，请重试，不会跳过此画面`);
    frames.push({ time, file });
  }
  return frames;
}
