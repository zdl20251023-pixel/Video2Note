import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
const require = createRequire(import.meta.url);
const VERSION = 'tesseract-7-eng-chi-sim-best-v1';

export async function bounded(operation, { signal, timeoutMs, message }) {
  if (signal?.aborted) throw new Error('CANCELLED');
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时')), timeoutMs);
    abort = () => reject(new Error('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function defaultWorkerFactory() {
  const cachePath = path.resolve('.local/ocr-cache'), languageRoot = path.resolve('.local/ocr-languages');
  await mkdir(cachePath, { recursive: true }); await mkdir(languageRoot, { recursive: true });
  for (const language of ['eng', 'chi_sim']) {
    const source = path.join(path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`)), '4.0.0_best_int', `${language}.traineddata.gz`);
    await writeFile(path.join(languageRoot, `${language}.traineddata.gz`), await readFile(source));
  }
  // Tesseract otherwise throws from its message callback after rejecting recognize().
  // A caller's try/catch cannot intercept that asynchronous throw.
  return createWorker(['eng', 'chi_sim'], 1, { langPath: languageRoot, cachePath, logger: () => {}, errorHandler: () => {} });
}

export async function recognizeFrames(directory, frames, report, checkCancelled, { signal, timeoutMs = 30000, initializeTimeoutMs = 60000, workerFactory = defaultWorkerFactory, warmFrames = [] } = {}) {
  const file = path.join(directory, 'ocr-progress.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch {}
  if (state?.version !== VERSION) state = { version: VERSION, entries: {} };
  const warm = new Map(warmFrames.map(frame => [frame.file, frame]));
  const persist = async () => {
    state.updatedAt = new Date().toISOString();
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2)); await rename(`${file}.tmp`, file);
  };
  let worker, initialization, engineError, consecutiveFailures = 0;
  const results = [];
  const terminate = async () => {
    const target = worker; worker = null;
    if (target) {
      try { await bounded(() => target.terminate(), { timeoutMs: 2000 }); } catch {}
    }
  };
  try {
    for (let index = 0; index < frames.length; index++) {
      checkCancelled(); if (signal?.aborted) throw new Error('CANCELLED');
      const frame = frames[index];
      const digest = createHash('sha256').update(await readFile(path.join(directory, frame.file))).digest('hex');
      let saved = state.entries[frame.file];
      const seeded = warm.get(frame.file);
      if (saved?.digest !== digest && seeded?.digest === digest) {
        saved = { digest, status: seeded.ocrError ? 'failed' : 'completed', text: seeded.text, confidence: seeded.confidence, ...(seeded.ocrError ? { error: seeded.ocrError } : {}) };
        state.entries[frame.file] = saved; await persist();
      }
      if (saved?.digest === digest && ['completed', 'failed'].includes(saved.status)) {
        report({ stage: 'ocr', progress: 74 + Math.round((index + 1) / frames.length * 17), message: `复用已保存 OCR ${index + 1}/${frames.length}；不会从头识别` });
        results.push({ ...frame, text: saved.text || '', confidence: saved.confidence || 0, ...(saved.error ? { ocrError: saved.error } : {}) });
        continue;
      }
      report({ stage: 'ocr', progress: 74 + Math.round(index / frames.length * 17), message: `正在识别第 ${index + 1}/${frames.length} 张画面（逐张保存，单张最长 ${Math.ceil(timeoutMs / 1000)} 秒）` });
      try {
        if (consecutiveFailures >= 2) throw new Error('OCR 连续失败，本次跳过剩余 OCR；原图仍提交视觉模型分析');
        if (!worker) {
          let abandoned = false;
          initialization = Promise.resolve().then(workerFactory);
          initialization.then(value => { if (abandoned) Promise.resolve(value.terminate()).catch(() => {}); }, () => {});
          try {
            worker = await bounded(() => initialization, { signal, timeoutMs: initializeTimeoutMs, message: 'OCR 引擎初始化超时' });
            engineError = null;
            worker.worker?.on?.('error', error => { engineError = error; });
          }
          catch (error) { abandoned = true; throw error; }
        }
        const { data } = await bounded(() => worker.recognize(path.join(directory, frame.file)), { signal, timeoutMs, message: '单张 OCR 超时，已跳过文字识别；原图仍保留用于模型分析' });
        saved = { digest, status: 'completed', text: String(data.text || '').trim(), confidence: Number.isFinite(data.confidence) ? data.confidence : 0 };
        consecutiveFailures = 0;
      } catch (error) {
        await terminate();
        checkCancelled(); if (signal?.aborted || error.message === 'CANCELLED') throw new Error('CANCELLED');
        consecutiveFailures++;
        saved = { digest, status: 'failed', text: '', confidence: 0, error: String(engineError?.message || error.message || error).slice(0, 500) };
      }
      state.entries[frame.file] = saved; await persist();
      results.push({ ...frame, text: saved.text, confidence: saved.confidence, ...(saved.error ? { ocrError: saved.error } : {}) });
    }
    return results;
  } finally { await terminate(); }
}
