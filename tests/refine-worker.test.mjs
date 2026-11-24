import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../server/store.mjs';

test('historical refinement uses only existing Markdown in the original task folder and preserves video completion', { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'video-historical-refine-'));
  const received = [];
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    assert.equal(req.headers.authorization, 'Bearer fixture-refine-key');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ markdown: '## 重点与教学主线\n\n先确认 HJ 与 CO 的位置和 KK 手牌，再按翻前、翻牌、转牌、河牌演示下注动作。保留关键金额和花色，以对手范围解释决策；底池与筹码未知时标记待核对。\n\n### 旁白\n\n我们先看位置，再看下注前提，最后总结河牌决策。' }) } }] }));
  });
  let child;
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const id = randomUUID(), jobId = randomUUID();
    const directory = path.join(root, 'artifacts/tasks', id); await mkdir(directory, { recursive: true }); await mkdir(path.join(root, '.local'));
    const source = '# 完整资料\n\nHJ 开池，CO 持 KK 加注，逐街分析下注理由和适用前提。';
    for (const name of ['视频信息整理.md', '教学讲稿.md']) await writeFile(path.join(directory, name), source);
    const db = new DatabaseSync(path.join(root, '.local/tasks.sqlite')); db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE refinement_jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tasks VALUES (?,?)').run(id, JSON.stringify({ id, title: '历史视频', status: 'completed', createdAt: now, updatedAt: now, options: {}, result: { fullPlayback: true, noteMode: 'model-semantic' } }));
    db.prepare('INSERT INTO refinement_jobs VALUES (?,?)').run(jobId, JSON.stringify({ id: jobId, kind: 'refinement', targetTaskId: id, targets: ['video', 'script'], status: 'queued', createdAt: now, updatedAt: now, model: { providerId: 'mock', providerLabel: 'Mock', modelId: 'text-model', modelLabel: 'Text', baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKeyEnv: 'REFINEMENT_TEST_KEY', requestDefaults: {}, timeoutMs: 3000, maxInputChars: 24000, maxOutputTokens: 2000 } })); db.close();
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', VIDEO2NOTE_DATA_ROOT: root, REFINEMENT_TEST_KEY: 'fixture-refine-key' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000); child.on('error', reject);
      child.stdout.on('data', bytes => { const url = bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
    });
    let task;
    const end = Date.now() + 8000;
    do { task = await (await fetch(`${base}/api/tasks/${id}`)).json(); if (task.refinement?.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < end);
    assert.equal(task.status, 'completed'); assert.equal(task.refinement.status, 'completed');
    assert.equal((await (await fetch(`${base}/api/tasks`)).json()).length, 1);
    const manifest = await (await fetch(`${base}/api/tasks/${id}/artifacts`)).json();
    for (const name of ['视频重点.md', '精简讲稿.md']) {
      assert.ok(manifest.documents.includes(name));
      const file = await fetch(`${base}/api/tasks/${id}/file?path=${encodeURIComponent(name)}&download=1`); assert.equal(file.status, 200);
    }
    assert.equal(await readFile(path.join(directory, '视频信息整理.md'), 'utf8'), source);
    await assert.rejects(readFile(path.join(directory, 'acquisition.json')), { code: 'ENOENT' });
    assert.equal(received.length, 4); assert.ok(received.every(body => body.messages.every(message => typeof message.content === 'string')));
    const zip = Buffer.from(await (await fetch(`${base}/api/tasks/${id}/archive`)).arrayBuffer());
    assert.ok(zip.includes(Buffer.from('视频重点.md')) && zip.includes(Buffer.from('精简讲稿.md')));
    const local = await fetch(`${base}/api/tasks/${id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: { providerId: 'local', modelId: 'local' } }) });
    assert.equal(local.status, 400);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => mock.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});
