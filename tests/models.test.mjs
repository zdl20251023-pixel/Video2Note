import { teachingReply } from './teaching-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, validateConfig, resolveSelection, snapshotModel, callModel, networkErrorMessage } from '../server/models.mjs';
import { chunkCues, validateSummary, writeSemanticNotes } from '../server/semantic.mjs';
import { writeNotes } from '../server/notes.mjs';

const answer = { overview: '根据教学内容减少无依据的诈唬。', keyPoints: [{ title: '利用对手失误', detail: '根据对手实际倾向调整策略，先确认适用条件。', timeSeconds: 1 }], chapters: [{ title: '对手调整', detail: '解释适用条件。', timeSeconds: 1 }], cases: [], review: ['为什么需要根据对手调整？'] };
test('network permissions, DNS, TLS and timeouts are distinguishable without leaking raw errors', async () => {
  assert.match(networkErrorMessage('DeepSeek', { cause: { code: 'EACCES' } }), /网络访问被系统限制/);
  assert.match(networkErrorMessage('DeepSeek', { cause: { errors: [{ code: 'EPERM' }] } }), /这不是密钥错误/);
  assert.match(networkErrorMessage('DeepSeek', { cause: { code: 'ENOTFOUND' } }), /域名解析失败/);
  assert.match(networkErrorMessage('DeepSeek', { cause: { code: 'CERT_HAS_EXPIRED' } }), /证书验证失败/);
  assert.match(networkErrorMessage('DeepSeek', { name: 'TimeoutError' }), /请求超时/);
  const snapshot = await snapshotModel({ providerId: 'deepseek', modelId: 'deepseek-flash' }, false);
  await assert.rejects(callModel(snapshot, [], { apiKey: 'test-key', fetchImpl: async () => { throw new TypeError('sensitive raw error', { cause: { code: 'EACCES' } }); } }), error => error.message.includes('网络访问被系统限制') && !error.message.includes('sensitive'));
});
test('default DeepSeek and Gemini use the same configurable protocol; adding a provider needs only config', async () => {
  const config = await loadConfig();
  assert.deepEqual(config.defaultSelection, { providerId: 'deepseek', modelId: 'deepseek-flash' });
  assert.equal(resolveSelection(config, { providerId: 'gemini', modelId: 'gemini-3.6-flash' }).provider.protocol, 'openai-chat');
  config.providers.push({ ...config.providers[1], id: 'another', label: 'Another service', baseUrl: 'https://example.org/v1', apiKeyEnv: 'ANOTHER_KEY' });
  assert.equal(resolveSelection(validateConfig(config), { providerId: 'another', modelId: 'gemini-3.6-flash' }).provider.id, 'another');
  assert.equal(resolveSelection(config, { providerId: 'local', modelId: 'local' }), null);
});
test('config refuses embedded secrets, unknown protocols and message overrides', async () => {
  for (const mutate of [c => { c.providers[0].baseUrl = 'https://secret@example.org/v1'; }, c => { c.providers[0].baseUrl += '?key=secret'; }, c => { c.providers[0].protocol = 'unknown'; }, c => { c.providers[0].requestDefaults.messages = []; }]) {
    const config = await loadConfig(); mutate(config); assert.throws(() => validateConfig(config));
  }
});
test('credentials and preferences persist privately without key values in public catalog or task snapshots', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poker-model-settings-'));
  const previous = process.env.POKER_MODEL_STATE_DIR;
  const previousConfig = process.env.POKER_MODELS_CONFIG;
  const configPath = path.join(directory, 'models.json');
  const config = await loadConfig();
  await writeFile(configPath, JSON.stringify(config));
  let isolated;
  try {
    process.env.POKER_MODEL_STATE_DIR = directory;
    process.env.POKER_MODELS_CONFIG = configPath;
    isolated = await import(`../server/models.mjs?isolated=${randomUUID()}`);
  } finally {
    if (previous === undefined) delete process.env.POKER_MODEL_STATE_DIR;
    else process.env.POKER_MODEL_STATE_DIR = previous;
    if (previousConfig === undefined) delete process.env.POKER_MODELS_CONFIG;
    else process.env.POKER_MODELS_CONFIG = previousConfig;
  }
  await isolated.saveCredential('deepseek', { apiKey: 'private-test-key-do-not-display' });
  const catalog = await isolated.modelCatalog();
  assert.ok(!JSON.stringify(catalog).includes('private-test-key-do-not-display'));
  assert.equal(catalog.providers.find(p => p.id === 'deepseek').keySource, 'file');
  const snapshot = await isolated.snapshotModel({ providerId: 'deepseek', modelId: 'deepseek-flash' });
  assert.ok(!JSON.stringify(snapshot).includes('private-test-key-do-not-display'));
  await isolated.savePreference({ providerId: 'gemini', modelId: 'gemini-3.6-flash' });
  assert.equal((await isolated.modelCatalog()).defaultSelection.providerId, 'gemini');
  await isolated.saveCredential('deepseek', { removeKey: true });
  assert.notEqual((await isolated.modelCatalog()).providers.find(p => p.id === 'deepseek').keySource, 'file');
  config.providers.push({ ...config.providers[0], id: 'future-provider', label: 'Future provider', apiKeyEnv: 'FUTURE_PROVIDER_KEY' });
  await writeFile(configPath, JSON.stringify(config));
  assert.ok((await isolated.modelCatalog()).providers.some(provider => provider.id === 'future-provider'));
});
test('adapter sends auth only in headers, routes Gemini by config, and keeps provider defaults isolated', async () => {
  for (const selection of [{ providerId: 'deepseek', modelId: 'deepseek-flash' }, { providerId: 'gemini', modelId: 'gemini-3.6-flash' }]) {
    const snapshot = await snapshotModel(selection, false);
    let sent;
    const result = await callModel(snapshot, [{ role: 'user', content: 'sample' }], { apiKey: 'test-key-not-a-real-credential', fetchImpl: async (url, options) => {
      sent = { url, ...options, body: JSON.parse(options.body) };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '连接成功' } }], usage: { total_tokens: 12 } });
    } });
    assert.equal(result.text, '连接成功');
    assert.equal(sent.body.model, selection.modelId);
    assert.equal(sent.headers.Authorization, 'Bearer test-key-not-a-real-credential');
    assert.ok(!JSON.stringify(sent.body).includes('test-key-not-a-real-credential'));
    assert.equal(!!sent.body.thinking, selection.providerId === 'deepseek');
    assert.ok(sent.url.startsWith(snapshot.baseUrl));
  }
});
test('failed and truncated responses do not leak provider errors or become valid notes', async () => {
  const snapshot = await snapshotModel({ providerId: 'deepseek', modelId: 'deepseek-flash' }, false);
  await assert.rejects(callModel(snapshot, [], { apiKey: 'private-test-key', fetchImpl: async () => Response.json({ error: 'private-test-key' }, { status: 401 }) }), error => error.message.includes('API Key 无效') && !error.message.includes('private-test-key'));
  await assert.rejects(callModel(snapshot, [], { apiKey: 'test-key', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }), /截断/);
  await assert.rejects(callModel(snapshot, [], { apiKey: 'test-key', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: {} }] }) }), /未返回总结正文/);
});
test('cancellation aborts requests and summary validation rejects invented out-of-range timestamps', async () => {
  const controller = new AbortController(); controller.abort();
  const snapshot = await snapshotModel({ providerId: 'deepseek', modelId: 'deepseek-flash' }, false);
  await assert.rejects(callModel(snapshot, [], { apiKey: 'test-key', signal: controller.signal, fetchImpl: async () => { throw new Error('aborted'); } }), /CANCELLED/);
  assert.throws(() => validateSummary(JSON.stringify({ ...answer, keyPoints: [{ ...answer.keyPoints[0], timeSeconds: 200 }] }), 10), /时间戳/);
  assert.throws(() => validateSummary('not json', 10), /有效 JSON/);
});
test('long captions are split on cue boundaries without loss', () => {
  const cues = Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, text: '中文讲解内容'.repeat(20) }));
  const chunks = chunkCues(cues, 400);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), cues);
});
test('semantic notes render using a mock service, retain local evidence and honor vision opt-out', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poker-notes-model-'));
  await mkdir(path.join(directory, 'images')); await mkdir(path.join(directory, 'captions'));
  await writeFile(path.join(directory, 'captions/zh.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n根据对手失误调整策略，必须先理解适用条件。\n');
  await writeFile(path.join(directory, 'images/frame-001.png'), 'mock image bytes');
  const media = { title: '测试课程', url: 'https://pokercoaching.com/courses/a/b/', duration: 10, coveredSeconds: 10, fullPlayback: true, captions: { zh: 'captions/zh.vtt' }, warnings: [] };
  const frames = [{ time: 2, file: 'images/frame-001.png', text: 'board', confidence: 40 }];
  const snapshot = await snapshotModel({ providerId: 'deepseek', modelId: 'deepseek-flash' }, false);
  const local = await writeNotes(directory, media, frames, []);
  let imageCount;
  const invoke = async (_config, messages) => { if (Array.isArray(messages[1].content)) imageCount = messages[1].content.filter(part => part.type === 'image_url').length; return { text: JSON.stringify(teachingReply(messages)), usage: { total_tokens: 20 } }; };
  const result = await writeSemanticNotes(directory, media, frames, local, snapshot, { includeImages: true, report: () => {}, checkCancelled: () => {}, invoke });
  assert.equal(result.noteMode, 'model-semantic'); assert.equal(imageCount, 1);
  const markdown = await readFile(path.join(directory, '学习笔记.md'), 'utf8');
  assert.ok(markdown.includes('DeepSeek / deepseek-flash')); assert.ok(markdown.includes('keyframes/frame-001.png'));
  assert.ok((await readFile(path.join(directory, '本地整理.md'), 'utf8')).includes('本地字幕提取式整理'));
  await writeSemanticNotes(directory, media, frames, local, snapshot, { includeImages: false, report: () => {}, checkCancelled: () => {}, invoke });
  assert.equal(imageCount, 0);
  await assert.rejects(writeSemanticNotes(directory, media, frames, local, { ...snapshot, vision: false }, { includeImages: true, report: () => {}, checkCancelled: () => {}, invoke }), /不支持图片/);
});
