import { teachingReply } from './teaching-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, OUTPUT, taskDirectory } from '../server/store.mjs';

const answer = { overview: '课堂讲解了针对对手进行调整。', keyPoints: [{ title: '根据对手调整', detail: '先确认对手实际失误，再调整策略。', timeSeconds: 1 }], chapters: [], cases: [], review: ['对手的失误是什么？'] };

for (const failure of [false, true]) {
  test(`worker ${failure ? 'falls back to readable local notes on provider failure' : 'writes semantic notes with model provenance'}`, { timeout: 15000 }, async () => {
    const fixtureId = randomUUID(), id = randomUUID();
    const fixture = taskDirectory(fixtureId), directory = taskDirectory(id);
    let server, child;
    try {
      await mkdir(path.join(fixture, 'captions'), { recursive: true });
      await mkdir(path.join(fixture, 'images'), { recursive: true });
      await writeFile(path.join(fixture, 'captions/zh.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n根据对手实际失误调整策略，必须先确认适用条件。\n');
      await writeFile(path.join(fixture, 'acquisition.json'), JSON.stringify({ title: '集成测试课程', url: 'https://pokercoaching.com/courses/test/test/', duration: 10, coveredSeconds: 10, frameInterval: 30, fullPlayback: true, frames: [], captions: { zh: 'captions/zh.vtt' }, warnings: [] }));
      server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        assert.equal(req.url, '/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer test-only-not-a-real-key');
        assert.ok(!raw.includes('test-only-not-a-real-key'));
        res.writeHead(failure ? 401 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(failure ? { error: 'test-only-not-a-real-key' } : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(teachingReply(JSON.parse(raw).messages)) } }] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const task = { id, url: 'https://pokercoaching.com/courses/test/test/', source: 'url', cacheId: fixtureId, options: { ocr: false, includeImages: false, frameInterval: 30 }, model: { providerId: 'mock-integration-test', providerLabel: '模拟测试服务', modelId: 'mock-model', modelLabel: '模拟模型', baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'POKER_WORKER_TEST_KEY', timeoutMs: 3000, requestDefaults: {}, vision: false, maxInputChars: 24000, maxOutputTokens: 1000 } };
      const done = await new Promise((resolve, reject) => {
        child = fork(path.join(ROOT, 'server/worker.mjs'), [], { cwd: ROOT, env: { ...process.env, POKER_WORKER_TEST_KEY: 'test-only-not-a-real-key' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
        child.on('error', reject);
        let result;
        child.on('message', message => { if (message.type === 'done') result = message.patch; });
        child.on('exit', () => result ? resolve(result) : reject(new Error('Worker exited without a result')));
        child.send({ type: 'start', task });
      });
      assert.equal(done.status, failure ? 'partial' : 'completed');
      assert.equal(done.result.noteMode, failure ? 'local-extractive' : 'model-semantic');
      const note = await readFile(path.join(taskDirectory(id), '学习笔记.md'), 'utf8');
      assert.ok(!note.includes('test-only-not-a-real-key'));
      assert.ok(!JSON.stringify(done).includes('test-only-not-a-real-key'));
      if (failure) { assert.match(note, /已回退为本地整理/); assert.equal(done.result.model, null); }
      else { assert.match(note, /模拟测试服务/); assert.equal(done.result.model.modelId, 'mock-model'); }
    } finally {
      if (child && child.exitCode === null) child.kill();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      for (const target of [fixture, taskDirectory(id)]) {
        assert.ok(path.resolve(target).startsWith(path.resolve(OUTPUT) + path.sep));
        await rm(target, { recursive: true, force: true });
      }
    }
  });
}
