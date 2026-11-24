import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { refineDocuments, inspectRefinements, splitMarkdown } from '../server/refine.mjs';
const snapshot = { providerId: 'mock', providerLabel: 'Mock', modelId: 'text-model', modelLabel: 'Text model', vision: false, maxInputChars: 10000, maxOutputTokens: 3000 };
const answer = { markdown: '## 河牌决策重点\n\n王烨在 HJ 开池 1.5万，谭轩 CO 用 KK 加注到 7万。翻牌 5♥ 5♦ 6♥，转牌 A♦ 下注半池，河牌 10♥ 弃掉 KK，亮牌 7♦9♦。\n\n### 教学旁白与动画\n\n先标出位置和已知牌面，再按街依次演示行动，解释每个决策的适用前提。底池与有效筹码缺失时明确待核对。' };
async function fixture(long = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-refine-'));
  const video = '# 视频信息整理\n' + (long ? '同一手牌的重复背景与翻牌说明。\n'.repeat(1500) : '牌局背景：王烨 HJ、谭轩 CO。') + '\n最后独有事实：7♦9♦，河牌弃掉 KK。';
  const script = '# 教学讲稿\n\n### 教学旁白\n先确认位置，再演示各街动作与金额，解释河牌弃牌前提。';
  await writeFile(path.join(directory, '视频信息整理.md'), video); await writeFile(path.join(directory, '教学讲稿.md'), script);
  return { directory, video, script };
}
test('refinement reads only existing Markdown, writes two independent files and reuses cached model results', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const result = await refineDocuments(f.directory, snapshot, { invoke: async () => { calls++; return { text: JSON.stringify(answer) }; } });
    assert.equal(result.status, 'completed'); assert.ok(calls >= 4);
    assert.equal(await readFile(path.join(f.directory, '视频信息整理.md'), 'utf8'), f.video);
    assert.equal(await readFile(path.join(f.directory, '教学讲稿.md'), 'utf8'), f.script);
    for (const file of ['视频重点.md', '精简讲稿.md']) assert.match(await readFile(path.join(f.directory, file), 'utf8'), /7♦9♦/);
    await refineDocuments(f.directory, snapshot, { invoke: async () => { throw new Error('不应重复调用'); } });
    assert.equal((await inspectRefinements(f.directory)).outputs.video.status, 'completed');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('full long Markdown, including its tail, enters model processing with contiguous chunk coverage', async () => {
  const f = await fixture(true), inputs = [];
  try {
    const result = await refineDocuments(f.directory, snapshot, { targets: ['video'], invoke: async (_snapshot, messages) => { inputs.push(messages[1].content); return { text: JSON.stringify(answer) }; } });
    assert.equal(result.status, 'completed'); assert.ok(inputs.some(input => input.includes('最后独有事实：7♦9♦')));
    const state = JSON.parse(await readFile(path.join(f.directory, 'refinement-progress.json'), 'utf8'));
    assert.ok(state.outputs.video.chunks.length > 1);
    const chunks = splitMarkdown(f.video, 1500); assert.equal(chunks.map(chunk => chunk.text).join(''), f.video);
    assert.ok(chunks.every(chunk => chunk.text.length <= 1500));
    for (let index = 1; index < chunks.length; index++) assert.equal(chunks[index - 1].end, chunks[index].start);
    await writeFile(path.join(f.directory, '视频信息整理.md'), f.video + '\n新事实：翻前尺度待核对');
    assert.equal((await inspectRefinements(f.directory)).outputs.video.stale, true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('one failed refinement does not invalidate the other document, and retry preserves successful outputs', async () => {
  const f = await fixture(); let failed = true, videoCalls = 0;
  const invoke = async (_snapshot, messages) => {
    if (messages[1].content.startsWith('任务：video')) videoCalls++;
    if (failed && messages[1].content.startsWith('任务：script')) { const error = new Error('模拟权限错误'); error.httpStatus = 403; throw error; }
    return { text: JSON.stringify(answer) };
  };
  try {
    const first = await refineDocuments(f.directory, snapshot, { invoke }); assert.equal(first.status, 'partial');
    const count = videoCalls; failed = false;
    const second = await refineDocuments(f.directory, snapshot, { invoke }); assert.equal(second.status, 'completed'); assert.equal(videoCalls, count);
    await writeFile(path.join(f.directory, '教学讲稿.md'), f.script + '\n新分镜');
    assert.equal((await inspectRefinements(f.directory)).outputs.script.stale, true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('missing sources and partial source scope are explicit instead of inventing complete material', async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.directory, '教学讲稿.md'));
    const result = await refineDocuments(f.directory, snapshot, { sourcePartial: true, invoke: async () => ({ text: JSON.stringify(answer) }) });
    assert.equal(result.status, 'partial'); assert.equal(result.outputs.script.sourceMissing, true);
    assert.match(await readFile(path.join(f.directory, '视频重点.md'), 'utf8'), /部分内容/);
    assert.equal((await refineDocuments(f.directory, null)).status, 'unavailable');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('cancellation preserves finished chunks and resume does not resend their source text', async () => {
  const f = await fixture(true), controller = new AbortController(); const counts = new Map(); let abort = true;
  const invoke = async (_snapshot, messages) => {
    const content = messages[1].content; counts.set(content, (counts.get(content) || 0) + 1);
    if (abort && counts.size === 2) { controller.abort(); throw new Error('CANCELLED'); }
    return { text: JSON.stringify(answer) };
  };
  try {
    await assert.rejects(refineDocuments(f.directory, snapshot, { targets: ['video'], signal: controller.signal, invoke }), /CANCELLED/);
    const first = counts.keys().next().value; abort = false;
    const result = await refineDocuments(f.directory, snapshot, { targets: ['video'], invoke });
    assert.equal(result.status, 'completed'); assert.equal(counts.get(first), 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('changed sources during generation never publish a falsely fresh replacement', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.directory, '视频重点.md'), '原有的旧重点版');
    let changed = false;
    const result = await refineDocuments(f.directory, snapshot, { targets: ['video'], invoke: async () => {
      if (!changed) { changed = true; await writeFile(path.join(f.directory, '视频信息整理.md'), '源文档已修改'); }
      return { text: JSON.stringify(answer) };
    } });
    assert.equal(result.status, 'failed'); assert.equal(await readFile(path.join(f.directory, '视频重点.md'), 'utf8'), '原有的旧重点版');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('truncated global teaching output retries with increased token budget', async () => {
  const f = await fixture(), budgets = [];
  try {
    const result = await refineDocuments(f.directory, { ...snapshot, maxInputChars: 24000, maxOutputTokens: 12000 }, { targets: ['script'], invoke: async (_snapshot, messages, options) => {
      if (messages[0].content.includes('这是全局合并')) {
        budgets.push(options.maxTokens); if (budgets.length === 1) throw new Error('模型输出被截断，请调整 maxOutputTokens 或缩短输入');
      }
      return { text: JSON.stringify(answer) };
    } });
    assert.equal(result.status, 'completed'); assert.deepEqual(budgets, [6000, 9000]);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('global refinement corrects an excessive frame reference list instead of publishing it', async () => {
  const f = await fixture(); let merges = 0;
  try {
    const result = await refineDocuments(f.directory, snapshot, { targets: ['video'], invoke: async (_snapshot, messages) => {
      if (messages[0].content.includes('这是全局合并') && ++merges === 1) return { text: JSON.stringify({ markdown: answer.markdown + Array.from({ length: 13 }, (_, i) => `\n[图片${i}](keyframes/frame-${i}.png)`).join('') }) };
      return { text: JSON.stringify(answer) };
    } });
    assert.equal(result.status, 'completed'); assert.equal(merges, 2);
    assert.doesNotMatch(await readFile(path.join(f.directory, '视频重点.md'), 'utf8'), /图片12/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
