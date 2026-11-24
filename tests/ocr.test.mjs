import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recognizeFrames } from '../server/ocr.mjs';
const noop = () => {};
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-ocr-'));
  await mkdir(path.join(directory, 'images'));
  const frames = [0, 1, 2].map(i => ({ file: `images/frame-${i + 1}.png`, time: i * 5 }));
  for (const frame of frames) await writeFile(path.join(directory, frame.file), frame.file);
  return { directory, frames };
}

test('OCR cancellation interrupts a stuck recognition, preserves completed frames, and resumes without repeating them', async () => {
  const f = await fixture(), controller = new AbortController();
  let terminated = 0, calls = 0;
  try {
    await assert.rejects(recognizeFrames(f.directory, f.frames, noop, noop, { signal: controller.signal, workerFactory: async () => ({ recognize: async () => {
      calls++;
      if (calls === 1) return { data: { text: '已完成的文字', confidence: 90 } };
      setTimeout(() => controller.abort(), 15); return new Promise(() => {});
    }, terminate: async () => { terminated++; } }) }), /CANCELLED/);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'ocr-progress.json'), 'utf8'));
    assert.equal(Object.values(saved.entries).filter(frame => frame.status === 'completed').length, 1);
    let resumedCalls = 0;
    const results = await recognizeFrames(f.directory, f.frames, noop, noop, { workerFactory: async () => ({ recognize: async () => { resumedCalls++; return { data: { text: '续跑文字', confidence: 85 } }; }, terminate: async () => {} }) });
    assert.equal(resumedCalls, 2); assert.equal(results[0].text, '已完成的文字'); assert.equal(terminated, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('one OCR timeout skips only OCR, terminates its engine and preserves images for visual analysis', async () => {
  const f = await fixture(); let factories = 0, terminated = 0;
  try {
    const results = await recognizeFrames(f.directory, f.frames, noop, noop, { timeoutMs: 15, workerFactory: async () => {
      const hung = ++factories === 1;
      return { recognize: async () => hung ? new Promise(() => {}) : { data: { text: '正常图片', confidence: 90 } }, terminate: async () => { terminated++; } };
    } });
    assert.match(results[0].ocrError, /超时/); assert.equal(results[1].text, '正常图片'); assert.equal(results.length, 3); assert.equal(terminated, 2);
    assert.ok((await readFile(path.join(f.directory, f.frames[0].file))).length);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('OCR cache is portable across retry folders but invalidated by changed image bytes', async () => {
  const f = await fixture(), retry = await mkdtemp(path.join(os.tmpdir(), 'video-ocr-retry-'));
  try {
    const options = { workerFactory: async () => ({ recognize: async () => ({ data: { text: '缓存文字', confidence: 90 } }), terminate: async () => {} }) };
    await recognizeFrames(f.directory, f.frames, noop, noop, options);
    await cp(f.directory, retry, { recursive: true }); await writeFile(path.join(retry, f.frames[1].file), '新的牌面内容');
    let calls = 0;
    const results = await recognizeFrames(retry, f.frames, noop, noop, { workerFactory: async () => ({ recognize: async () => { calls++; return { data: { text: '新牌面', confidence: 90 } }; }, terminate: async () => {} }) });
    assert.equal(calls, 1); assert.equal(results[0].text, '缓存文字'); assert.equal(results[1].text, '新牌面');
  } finally { await rm(f.directory, { recursive: true, force: true }); await rm(retry, { recursive: true, force: true }); }
});
