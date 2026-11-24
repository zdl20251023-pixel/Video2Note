import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskRunner, readCompletion } from '../server/task-runner.mjs';
import { spawn } from 'node:child_process';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Child extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.pid = 123; }
  send(message, done) { this.lastMessage = message; done?.(); }
  kill() { this.killed = true; this.emit('exit', null, 'SIGTERM'); }
}
function fixture(overrides = {}) {
  const rows = [{ id: 'second', status: 'queued' }, { id: 'first', status: 'queued' }], children = [];
  const runner = createTaskRunner({ listTasks: () => rows, getTask: id => rows.find(task => task.id === id), patchTask: (id, patch) => Object.assign(rows.find(task => task.id === id), patch), spawnWorker: () => { const child = new Child(); children.push(child); return child; }, cleanupGraceMs: 20, cancelGraceMs: 20, ...overrides });
  return { rows, children, runner };
}
test('done releases queue even if child stays alive; late exit cannot clear the next task', async () => {
  const f = fixture(); f.runner.schedule();
  f.children[0].emit('message', { type: 'done', patch: { status: 'completed' } });
  await delay(5); assert.equal(f.runner.active.id, 'second');
  await delay(25); assert.ok(f.children[0].killed); assert.equal(f.runner.active.id, 'second');
  f.children[0].emit('message', { type: 'progress', patch: { status: 'running' } }); assert.equal(f.rows[1].status, 'completed');
  f.children[1].emit('message', { type: 'done', patch: { status: 'completed' } }); await delay(25);
  assert.equal(f.runner.active, null);
});
test('cancel forces a hung worker to stop and starts the next queued task within the grace period', async () => {
  const f = fixture(); f.runner.schedule(); f.runner.cancel('first');
  await delay(40); assert.equal(f.rows[1].status, 'cancelled'); assert.equal(f.runner.active.id, 'second'); assert.ok(f.children[0].killed);
  f.children[1].emit('message', { type: 'done', patch: { status: 'completed' } }); await delay(25);
});
test('saved completion wins over a missing IPC done message and failed process exit', async () => {
  const f = fixture({ recover: async () => ({ status: 'partial', message: '已保存的模型结果' }) });
  f.runner.schedule(); f.children[0].emit('exit', 1, null);
  await delay(10); assert.equal(f.rows[1].status, 'partial'); assert.equal(f.runner.active.id, 'second');
  f.children[1].emit('message', { type: 'done', patch: { status: 'completed' } }); await delay(25);
});
test('unresponsive worker watchdog releases the queue instead of blocking subsequent work forever', async () => {
  const f = fixture({ heartbeatTimeoutMs: 25 }); f.runner.schedule();
  await delay(45); assert.equal(f.rows[1].status, 'failed'); assert.ok(f.children[0].killed);
  if (f.runner.active) f.children[1].emit('message', { type: 'done', patch: { status: 'completed' } }); await delay(25);
});
test('completion recovery reads existing result.json even when the parent only recorded process failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-completion-'));
  try {
    await writeFile(path.join(directory, 'result.json'), JSON.stringify({ fullPlayback: true, cueCount: 10, aiError: '课程列表格式不兼容', transcriptionComplete: true }));
    const patch = await readCompletion(directory); assert.equal(patch.status, 'partial'); assert.equal(patch.result.aiError, '课程列表格式不兼容');
    await writeFile(path.join(directory, 'completion.json'), JSON.stringify({ status: 'completed', message: '完整结果' }));
    assert.equal((await readCompletion(directory)).status, 'completed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real OS child ignoring cancellation is killed, while a completed child with a live event loop cannot hold the queue', { timeout: 10000 }, async () => {
  const rows = [{ id: 'second', status: 'queued' }, { id: 'first', status: 'queued' }], children = [];
  const runner = createTaskRunner({ listTasks: () => rows, getTask: id => rows.find(row => row.id === id), patchTask: (id, patch) => Object.assign(rows.find(row => row.id === id), patch), cleanupGraceMs: 50, cancelGraceMs: 50, heartbeatTimeoutMs: 3000, spawnWorker: () => {
    const child = spawn(process.execPath, ['-e', `setInterval(()=>{},1000);process.on('message',m=>{if(m.type==='start'){if(m.task.id==='first')process.send({type:'progress',patch:{stage:'ocr'}});else process.send({type:'done',patch:{status:'completed'}});}});`], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child); return child;
  } });
  const until = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('真实处理进程超时'); await delay(10); } };
  try {
    runner.schedule(); await until(() => rows[1].stage === 'ocr'); runner.cancel('first');
    await until(() => rows[1].status === 'cancelled' && rows[0].status === 'completed');
    assert.equal(runner.active, null);
    await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(children.length, 2);
  } finally { children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill(); }); }
});
