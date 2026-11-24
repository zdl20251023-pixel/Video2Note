import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../server/store.mjs';

test('HTTP serves titled and legacy tasks, documents, key images and ZIP without exposing arbitrary files', { timeout: 20000 }, async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'video-http-'));
  let child;
  try {
    const local = path.join(dataRoot, '.local'); await mkdir(local);
    const db = new DatabaseSync(path.join(local, 'tasks.sqlite'));
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const tasks = [];
    for (const named of [false, true]) {
      const id = randomUUID(), title = '河牌教学';
      const directory = path.join(dataRoot, 'artifacts/tasks', named ? `${title}_${id}` : id);
      await mkdir(path.join(directory, 'keyframes'), { recursive: true });
      await mkdir(path.join(directory, 'images'));
      for (const file of ['学习笔记.md', '教学讲稿.md', '视频解析.md', '视频信息整理.md']) await writeFile(path.join(directory, file), `# ${title}\n\n[查看图](keyframes/frame-001.png)`);
      await writeFile(path.join(directory, 'keyframes/frame-001.png'), 'test-image');
      await writeFile(path.join(directory, 'images/frame-001.png'), 'test-original');
      await writeFile(path.join(directory, '关键图片.json'), '{}');
      await writeFile(path.join(directory, '教学分镜.json'), '{}');
      await writeFile(path.join(directory, 'analysis-progress.json'), JSON.stringify({ batches: [{ id: 3, status: 'failed', error: '逐街信息缺少来源类型', files: ['images/frame-001.png'] }] }));
      await writeFile(path.join(directory, 'private.json'), 'private-data');
      const task = { id, title, status: 'completed', options: { frameInterval: 3 }, result: { noteMode: 'model-semantic' } };
      db.prepare('INSERT INTO tasks VALUES (?,?)').run(id, JSON.stringify(task)); tasks.push(task);
    }
    db.close();
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', VIDEO2NOTE_DATA_ROOT: dataRoot }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timer); reject(new Error(`服务提前退出 ${code}`)); });
      child.stdout.on('data', bytes => { const url = bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
    });
    assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
    for (const task of tasks) {
      assert.match(await (await fetch(`${base}/api/tasks/${task.id}/note`)).text(), /河牌教学/);
      const manifest = await (await fetch(`${base}/api/tasks/${task.id}/artifacts`)).json();
      assert.ok(manifest.documents.includes('教学讲稿.md'));
      assert.ok(manifest.documents.includes('视频信息整理.md'));
      assert.equal(manifest.errors[0].message, '逐街信息缺少来源类型');
      assert.equal(manifest.errors[0].batch, 3);
      // Availability comes from actual files even when task.result.documents is absent.
      for (const file of ['教学讲稿.md', '视频解析.md', 'keyframes/frame-001.png', 'analysis-progress.json', '教学分镜.json']) {
        const response = await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent(file)}&download=1`);
        assert.equal(response.status, 200, file); assert.match(response.headers.get('content-disposition'), /attachment/);
      }
      for (const file of ['private.json', '../private.json', 'keyframes/../private.json']) assert.equal((await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent(file)}`)).status, 404);
      const archive = await fetch(`${base}/api/tasks/${task.id}/archive`);
      assert.equal(archive.status, 200);
      const zip = Buffer.from(await archive.arrayBuffer());
      for (const filename of ['教学讲稿.md', '视频信息整理.md', '视频解析.md', 'keyframes/frame-001.png', '教学分镜.json', 'analysis-progress.json']) assert.ok(zip.includes(Buffer.from(filename)), filename);
      assert.ok(!zip.includes(Buffer.from('private.json')));
    }
    const invalid = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', options: { frameInterval: 2 } }) });
    assert.equal(invalid.status, 400); assert.match(await invalid.text(), /3–120/);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(dataRoot, { recursive: true, force: true });
  }
});
