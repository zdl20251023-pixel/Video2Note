import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseVideoUrl, isPlatformDomain, cookiesToNetscape } from '../server/platforms.mjs';
import { selectSubtitleLanguages, mediaError } from '../server/public-media.mjs';
import { ensureTranscript, transcribeSegment } from '../server/transcribe.mjs';
import { parseVtt } from '../server/notes.mjs';

function wave(seconds) {
  const buffer = Buffer.alloc(44 + 32000 * seconds);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
test('YouTube standard, short, shorts and mobile links normalize to a single video without playlist/tracking', () => {
  for (const value of ['https://www.youtube.com/watch?v=my5bEyyzD58&list=xx&t=90', 'https://youtu.be/my5bEyyzD58?si=secret', 'https://m.youtube.com/shorts/my5bEyyzD58', 'https://www.youtube.com/embed/my5bEyyzD58']) {
    assert.deepEqual(parseVideoUrl(value), { platform: 'youtube', url: 'https://www.youtube.com/watch?v=my5bEyyzD58' });
  }
});
test('Bilibili strips tracking, retains selected part, and rejects unsupported or forged domains', () => {
  assert.deepEqual(parseVideoUrl('https://www.bilibili.com/video/BV1b34y1B7Ns/?spm_id_from=x&vd_source=private&p=2'), { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1b34y1B7Ns/?p=2' });
  for (const value of ['https://www.youtube.com/playlist?list=x', 'https://www.youtube.com/watch?v=bad', 'https://youtube.com.evil.test/watch?v=my5bEyyzD58', 'https://www.bilibili.com/video/BV1b34y1B7Ns/?p=-1', 'https://b23.tv/example', 'https://www.bilibili.com/bangumi/play/ep1', 'https://user:pass@www.youtube.com/watch?v=my5bEyyzD58']) assert.throws(() => parseVideoUrl(value));
});
test('platform cookie export does not broaden to Google or other platform domains', () => {
  assert.equal(isPlatformDomain('.youtube.com', 'youtube'), true);
  assert.equal(isPlatformDomain('.google.com', 'youtube'), false);
  assert.equal(isPlatformDomain('.bilibili.com', 'youtube'), false);
  assert.equal(isPlatformDomain('.bilibili.com.evil.test', 'bilibili'), false);
  const serialized = cookiesToNetscape([{ domain: '.youtube.com', name: 'TEST', value: 'fake-value', path: '/', expires: -1, httpOnly: true, secure: true }]);
  assert.match(serialized, /#HttpOnly_\.youtube.com\tTRUE\t\/\tTRUE\t0\tTEST\tfake-value/);
});
test('manual subtitles take priority and unsupported caption streams are ignored', () => {
  const selected = selectSubtitleLanguages({ subtitles: { 'zh-Hant': [{}], en: [{}], 'en-../../private': [{}], live_chat: [{}] }, automatic_captions: { 'zh-Hans': [{}], 'en-orig': [{}] } });
  assert.deepEqual(selected, [{ alias: 'zh', language: 'zh-Hant', kind: 'site' }, { alias: 'en', language: 'en', kind: 'site' }]);
  assert.match(mediaError('youtube', 'Sign in to confirm your age'), /需要登录/);
  assert.match(mediaError('bilibili', 'HTTP Error 412'), /拒绝访问/);
});
test('speech API uses multipart with header-only credentials and repairs Chinese encoding', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poker-asr-api-'));
  const file = path.join(directory, 'sample.wav'); await writeFile(file, wave(1));
  const snapshot = { endpoint: 'https://api.example.test/asr', providerLabel: '测试语音', timeoutMs: 1000 };
  const text = await transcribeSegment(file, snapshot, { apiKey: 'test-only-key', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    assert.equal(options.body.get('file').type, 'audio/wav');
    return Response.json({ text: 'æˆ‘æ˜¯ Jonathan Littleï¼Œ' });
  } });
  assert.equal(text, '我是 Jonathan Little，');
  await assert.rejects(transcribeSegment(file, snapshot, { apiKey: 'test-only-key', fetchImpl: async () => Response.json({ error: 'test-only-key' }, { status: 401 }) }), error => error.message.includes('API Key 无效') && !error.message.includes('test-only-key'));
});
test('speech recognition resumes completed segments and preserves approximate timing provenance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'poker-asr-resume-'));
  await writeFile(path.join(directory, 'audio.wav'), wave(20));
  const media = { duration: 20, coveredSeconds: 20, fullPlayback: true, captions: {}, warnings: [] };
  const speech = { providerLabel: '模拟语音服务', segmentSeconds: 10 };
  let calls = 0;
  await assert.rejects(ensureTranscript(directory, media, speech, () => {}, () => {}, undefined, { invoke: async () => { calls++; if (calls === 2) throw new Error('temporary failure'); return '这是第一段中文讲解，说明基本规则和策略条件。'; } }), /temporary failure/);
  await ensureTranscript(directory, media, speech, () => {}, () => {}, undefined, { invoke: async () => { calls++; return '这是第二段中文讲解，说明下注和底池的基本概念。'; } });
  assert.equal(calls, 3);
  const cues = parseVtt(await readFile(path.join(directory, media.captions.zh), 'utf8'));
  assert.equal(cues.length, 2); assert.equal(cues[0].start, 0); assert.ok(Math.abs(cues[1].start - 10) < 0.15); assert.equal(cues[1].end, 20);
  assert.equal(media.captionSources.zh.kind, 'asr'); assert.equal(media.captionSources.zh.timing, 'segment');
  assert.equal(media.transcriptionComplete, true);
});
