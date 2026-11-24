import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { runProcess } from './public-media.mjs';
import { modelCredential, networkErrorMessage } from './models.mjs';
import { wavDuration } from '../scripts/playback-analysis.mjs';
import { parseVtt } from './notes.mjs';
import { normalizeSubtitleEncoding } from './captions.mjs';

const vttTime = n => `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${(n % 60).toFixed(3).padStart(6, '0')}`;
export async function transcribeSegment(file, snapshot, { signal, fetchImpl = fetch, apiKey } = {}) {
  const key = apiKey || await modelCredential(snapshot);
  if (!key) throw new Error('语音识别 API Key 未配置');
  const bytes = await readFile(file);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('语音分段超过 8 MiB 限制');
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav');
  let response;
  try {
    response = await fetchImpl(snapshot.endpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(snapshot.timeoutMs)]) : AbortSignal.timeout(snapshot.timeoutMs) });
  } catch (error) {
    if (signal?.aborted) throw new Error('CANCELLED');
    throw new Error(networkErrorMessage(snapshot.providerLabel, error));
  }
  if (!response.ok) {
    const reason = { 400: '音频格式不受支持', 401: 'API Key 无效', 402: '账户余额不足', 403: '语音服务无访问权限', 413: '音频分段过大', 429: '语音服务调用过于频繁', 503: '语音服务繁忙', 504: '语音识别超时' }[response.status] || `HTTP ${response.status}`;
    throw new Error(`${snapshot.providerLabel} 语音识别：${reason}`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('语音识别返回格式无效'); }
  if (typeof data.text !== 'string') throw new Error('语音识别未返回文字');
  return normalizeSubtitleEncoding(data.text).trim();
}
export async function ensureTranscript(directory, media, speech, report, checkCancelled, signal, { invoke = transcribeSegment } = {}) {
  for (const file of Object.values(media.captions || {})) {
    try { if (parseVtt(await readFile(path.join(directory, file), 'utf8')).length) return media; } catch {}
  }
  if (!speech) {
    media.warnings.push('未获取到站点字幕，且未启用语音识别；笔记将缺少语音讲解内容。');
    media.transcriptionComplete = false;
    return media;
  }
  const segments = path.join(directory, 'speech-segments');
  await mkdir(segments, { recursive: true });
  report({ stage: 'transcribing', progress: 72, message: '站点字幕缺失，正在准备语音识别分段' });
  const split = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(directory, 'audio.wav'), '-t', String(media.coveredSeconds), '-f', 'segment', '-segment_time', String(Math.min(speech.segmentSeconds, 119)), '-reset_timestamps', '1', '-c:a', 'pcm_s16le', path.join(segments, 'segment-%05d.wav')], { checkCancelled, timeout: 180000 });
  if (split.code) throw new Error('语音分段失败');
  const files = (await readdir(segments)).filter(file => /^segment-\d+\.wav$/.test(file)).sort();
  if (!files.length) throw new Error('没有可识别的音频片段');
  const cacheFile = path.join(directory, 'speech-progress.json');
  let cache = { segments: {} };
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
  const output = [];
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    checkCancelled();
    const file = path.join(segments, files[index]);
    const duration = await wavDuration(file);
    report({ stage: 'transcribing', progress: 72 + Math.round(index / files.length * 2), message: `正在使用 ${speech.providerLabel} 转写第 ${index + 1} / ${files.length} 段音频` });
    let text = cache.segments[index]?.text;
    if (typeof text !== 'string') {
      text = await invoke(file, speech, { signal });
      cache.segments[index] = { start: offset, end: offset + duration, text };
      await writeFile(cacheFile, JSON.stringify(cache, null, 2));
    }
    if (text) output.push({ start: offset, end: Math.min(offset + duration, media.coveredSeconds), text });
    offset += duration;
  }
  if (!output.length) throw new Error('音频中未识别到可用语音');
  const combined = output.map(cue => cue.text).join(' ');
  const language = (combined.match(/[\u3400-\u9fff]/g) || []).length > 10 ? 'zh' : 'en';
  const relative = `captions/${language}.vtt`;
  await mkdir(path.join(directory, 'captions'), { recursive: true });
  await writeFile(path.join(directory, relative), `WEBVTT\n\n${output.map((cue, index) => `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`);
  media.captions ||= {}; media.captions[language] = relative;
  media.captionSources ||= {}; media.captionSources[language] = { kind: 'asr', provider: speech.providerLabel, timing: 'segment', segmentSeconds: speech.segmentSeconds };
  media.transcriptionComplete = true;
  media.warnings.push(`原视频无可用字幕，使用 ${speech.providerLabel} 语音识别；时间戳按约 ${speech.segmentSeconds} 秒音频分段定位，不是逐字精确对齐。术语、牌面和数字需核对。`);
  await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
  return media;
}
