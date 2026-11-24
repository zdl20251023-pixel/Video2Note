import { mkdir, readFile, writeFile, copyFile, cp, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, taskDirectory, nameTaskDirectory, getTask, refinementJobDirectory } from './store.mjs';
import { extractFrames } from './public-media.mjs';
import { acquire } from './acquire.mjs';
import { recognizeFrames, writeNotes } from './notes.mjs';
import { normalizeSubtitleEncoding } from './captions.mjs';
import { writeSemanticNotes } from './semantic.mjs';
import { ensureTranscript } from './transcribe.mjs';
import { refineDocuments, inspectRefinements } from './refine.mjs';
let cancelled = false;
let cachedOcr = null;
const modelAbort = new AbortController();
const report = patch => { if (process.connected) process.send({ type: 'progress', patch }, () => {}); };
const heartbeat = setInterval(() => { if (process.connected) process.send({ type: 'heartbeat' }, () => {}); }, 5000);
heartbeat.unref();
let outputDirectory;
process.on('disconnect', () => { cancelled = true; modelAbort.abort(); });
async function finishTask(patch) {
  if (outputDirectory) {
    await writeFile(path.join(outputDirectory, 'completion.json.tmp'), JSON.stringify(patch));
    await rename(path.join(outputDirectory, 'completion.json.tmp'), path.join(outputDirectory, 'completion.json'));
  }
  await new Promise(resolve => {
    if (!process.connected) return resolve();
    try { process.send({ type: 'done', patch }, () => resolve()); } catch { resolve(); }
  });
}
const checkCancelled = () => { if (cancelled) throw new Error('CANCELLED'); };

async function cachedMedia(id, directory, task) {
  const original = taskDirectory(id);
  const media = JSON.parse(await readFile(path.join(original, 'acquisition.json'), 'utf8'));
  let resampled = false;
  for (const item of ['images', 'captions', 'audio.wav', 'audio.webm', 'speech-progress.json', 'analysis-progress.json', 'ocr-progress.json', 'refinement-progress.json', '视频重点.md', '精简讲稿.md']) {
    try { if (original !== directory) await cp(path.join(original, item), path.join(directory, item), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (media.sourceVideo) {
    if (original !== directory) await copyFile(path.join(original, media.sourceVideo), path.join(directory, media.sourceVideo));
    if (media.frameInterval !== task.options.frameInterval) {
      await rm(path.join(directory, 'images'), { recursive: true, force: true });
      await mkdir(path.join(directory, 'images'), { recursive: true });
      media.frames = await extractFrames(directory, media.sourceVideo, media.coveredSeconds, task.options.frameInterval, report, checkCancelled);
      media.frameInterval = task.options.frameInterval;
      resampled = true;
    }
  } else if ((media.frameInterval ?? getTask(id)?.options?.frameInterval) !== task.options.frameInterval && task.source !== 'sample') {
    throw new Error('已有素材缺少源视频，无法按新的截图间隔重新采样，请重新提交视频链接');
  }
  const previous = getTask(id);
  let previousResult = previous?.result;
  if (!previousResult) { try { previousResult = JSON.parse(await readFile(path.join(original, 'result.json'), 'utf8')); } catch {} }
  const oldFrames = previousResult?.frames;
  if (!resampled && task.options.ocr && previous?.options?.ocr && oldFrames?.length === media.frames.length && media.frames.every((frame, index) => oldFrames[index].file === frame.file && oldFrames[index].time === frame.time && typeof oldFrames[index].text === 'string' && Number.isFinite(oldFrames[index].confidence))) { cachedOcr = []; for (const frame of oldFrames) { cachedOcr.push({ ...frame, digest: createHash('sha256').update(await readFile(path.join(original, frame.file))).digest('hex') }); } }
  await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
  return media;
}
async function sampleMedia(directory) {
  const source = path.join(ROOT, 'artifacts/continuous-verification/welcome-to-the-complete-cash-game-system');
  const summary = JSON.parse(await readFile(path.join(source, 'summary.json'), 'utf8'));
  await mkdir(path.join(directory, 'images'), { recursive: true });
  await mkdir(path.join(directory, 'captions'), { recursive: true });
  const frames = [];
  for (let i = 0; i < summary.frames.length; i++) {
    const frame = summary.frames[i], file = `images/frame-${String(i + 1).padStart(3, '0')}.png`;
    await copyFile(path.join(source, frame.file), path.join(directory, file));
    frames.push({ file, time: frame.actualTime });
  }
  await copyFile(path.join(source, 'captions.zh.vtt'), path.join(directory, 'captions/zh.vtt'));
  await copyFile(path.join(source, 'audio.wav'), path.join(directory, 'audio.wav'));
  const media = { title: 'Welcome to the Complete Cash Game System', url: summary.url, duration: summary.duration, fullPlayback: summary.status === 'full-playback-verified', coveredSeconds: summary.recordedAudioSeconds, frames, captions: { zh: 'captions/zh.vtt' }, warnings: [], importedFromVerifiedSample: true };
  await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
  return media;
}

process.on('message', async message => {
  if (message.type === 'cancel') { cancelled = true; modelAbort.abort(); return; }
  if (message.type !== 'start') return;
  const task = message.task;
  try {
    if (task.kind === 'refinement') {
      outputDirectory = refinementJobDirectory(task.id); await mkdir(outputDirectory, { recursive: true });
      const original = getTask(task.targetTaskId);
      if (!original) throw new Error('原视频任务不存在');
      const refinement = await refineDocuments(taskDirectory(original.id), task.model, { targets: task.targets, force: task.force, operationId: task.id, sourcePartial: original.result?.fullPlayback === false, signal: modelAbort.signal, checkCancelled, report });
      await finishTask({ status: refinement.status, stage: 'refined', progress: 100, message: refinement.message, refinement, finishedAt: new Date().toISOString() }); return;
    }
    let directory = taskDirectory(task.id);
    await mkdir(directory, { recursive: true });
    outputDirectory = directory;
    report({ stage: 'inspecting', progress: 3, message: task.source === 'sample' ? '正在载入此前实际验证的课程素材' : '正在准备课程提取' });
    const media = task.cacheId ? await cachedMedia(task.cacheId, directory, task) : task.source === 'sample' ? await sampleMedia(directory) : await acquire(task, directory, report, checkCancelled);
    directory = nameTaskDirectory(task.id, media.title);
    outputDirectory = directory;
    report({ title: media.title, outputDirectory: path.basename(directory) });
    try { await ensureTranscript(directory, media, task.speech, report, checkCancelled, modelAbort.signal); }
    catch (error) {
      checkCancelled();
      media.transcriptionComplete = false;
      media.warnings.push(`语音识别未完成：${error.message}。已保留音频与成功分段，可重试。`);
      await writeFile(path.join(directory, 'acquisition.json'), JSON.stringify(media, null, 2));
    }
    for (const file of Object.values(media.captions)) {
      const target = path.join(directory, file);
      await writeFile(target, normalizeSubtitleEncoding(await readFile(target, 'utf8')));
    }
    checkCancelled();
    report({ title: media.title, duration: media.duration, elapsed: media.coveredSeconds, frameCount: media.frames.length, stage: 'ocr', progress: 74, message: '正在准备本地文字识别' });
    const warnings = [...media.warnings];
    let ocr = [];
    if (task.options.ocr) {
      try { ocr = await recognizeFrames(directory, media.frames, report, checkCancelled, { signal: modelAbort.signal, warmFrames: cachedOcr || [] }); }
      catch (error) { checkCancelled(); warnings.push(`画面 OCR 未完成：${error.message}。字幕整理仍可用。`); }
    } else { warnings.push('本次关闭了 OCR，截图仅作为视觉参考。'); }
    const ocrFailures = ocr.filter(frame => frame.ocrError);
    if (ocrFailures.length) warnings.push(`${ocrFailures.length} 张截图的本地 OCR 超时或失败，已保存状态并跳过 OCR；原图仍用于模型分析。`);
    const lowConfidenceCount = ocr.filter(frame => frame.confidence < 60).length;
    if (lowConfidenceCount) warnings.push(`${lowConfidenceCount} 张画面的 OCR 置信度低于 60%，可能含误识别；请核对截图，不直接据此判断牌面和下注数字。`);
    checkCancelled();
    // Include screenshots even when OCR is disabled or fails.
    const annotatedFrames = media.frames.map(frame => ocr.find(item => item.file === frame.file) || { ...frame, text: '', confidence: 0 });
    report({ stage: 'summarizing', progress: 94, message: '正在按时间组织原文要点与关键画面' });
    let notes = await writeNotes(directory, media, annotatedFrames, warnings);
    let ai = null, aiError = null;
    if (task.model) {
      try {
        ai = await writeSemanticNotes(directory, { ...media, warnings: warnings.filter(w => !w.startsWith('本地模式保留原语言字幕')) }, annotatedFrames, notes, task.model, { includeImages: task.options.includeImages, report, checkCancelled, signal: modelAbort.signal });
        notes = { ...notes, ...ai };
        const index = warnings.findIndex(w => w.startsWith('本地模式保留原语言字幕'));
        if (index >= 0) warnings.splice(index, 1);
      } catch (error) {
        checkCancelled();
        aiError = error.message;
        ai = error.artifacts || null;
        warnings.push(ai ? `部分步骤未完成，已保留图文信息及可用讲稿：${error.message}` : `模型语义总结未完成，已回退为本地整理：${error.message}`);
        notes = ai ? { ...notes, ...ai } : await writeNotes(directory, media, annotatedFrames, warnings);
      }
    }
    let analysis = ai?.analysis || null;
    if (!analysis) { try { analysis = JSON.parse(await readFile(path.join(directory, 'analysis-progress.json'), 'utf8')).coverage; } catch {} }
    let result = { artifactStatus: ai?.artifactStatus || null, documents: ai?.documents || ['视频信息整理.md'], keyframes: ai?.keyframes || [], analysis, platform: media.platform || task.platform || 'pokercoaching', validationMethod: media.validationMethod || 'browser-playback', transcriptionComplete: media.transcriptionComplete !== false, captionSources: media.captionSources || {}, fullPlayback: media.fullPlayback, coveredSeconds: media.coveredSeconds, duration: media.duration, frameCount: media.frames.length, cueCount: notes.cueCount, language: notes.language, warnings: [...new Set(warnings)], noteMode: notes.noteMode, model: ai?.model || null, aiError, summaryCalls: ai?.summaryCalls || 0, usage: ai?.usage || [], frames: annotatedFrames, captions: media.captions, hasAudio: true };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    report({ result, stage: 'refining', progress: 99, refinement: { status: 'running', message: '完整文档已保存，正在生成重点版', progress: 0 } });
    let refinement;
    try {
      refinement = await refineDocuments(directory, task.model, { operationId: task.id, sourcePartial: !media.fullPlayback, signal: modelAbort.signal, checkCancelled, report: patch => report({ stage: 'refining', progress: 99, message: patch.message, refinement: { status: 'running', message: patch.message, progress: patch.progress } }) });
    } catch (error) { checkCancelled(); refinement = { status: 'failed', message: error.message, outputs: (await inspectRefinements(directory)).outputs }; }
    result = { ...result, refinement, documents: [...new Set([...result.documents, ...Object.values(refinement.outputs || {}).filter(output => output.available).map(output => output.file)])] };
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    checkCancelled();
    const complete = media.fullPlayback && notes.cueCount && !aiError && media.transcriptionComplete !== false;
    await finishTask({ refinement, status: complete ? 'completed' : 'partial', stage: 'complete', progress: 100, message: aiError ? '部分步骤未完成，已保留可用的信息与图片，可继续整理' : complete ? '视频信息整理与教学产物已生成' : '已生成部分内容，请查看完整性说明', result, title: media.title, finishedAt: new Date().toISOString() });
  } catch (error) {
    await finishTask({ status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? '任务已取消' : error.message, finishedAt: new Date().toISOString() });
  } finally { clearInterval(heartbeat); if (process.connected) process.disconnect(); setTimeout(() => process.exit(0), 50); }
});
