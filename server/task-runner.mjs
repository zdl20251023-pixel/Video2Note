import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readCompletion(directory) {
  try {
    const patch = JSON.parse(await readFile(path.join(directory, 'completion.json'), 'utf8'));
    if (['completed', 'partial', 'failed', 'cancelled'].includes(patch.status)) return patch;
  } catch {}
  try {
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    const complete = result.fullPlayback && result.cueCount && !result.aiError && result.transcriptionComplete !== false;
    return { status: complete ? 'completed' : 'partial', stage: 'complete', progress: 100, result, message: result.aiError ? `处理结果已恢复，待继续：${result.aiError}` : '已从保存的处理结果恢复', finishedAt: new Date().toISOString(), recoveredCompletion: true };
  } catch { return null; }
}

// One owner controls a queue slot. Terminal messages, child exits and late events
// cannot release or overwrite a different worker's slot.
export function createTaskRunner({ listTasks, getTask, patchTask, spawnWorker, recover = async () => null, log = () => {}, cancelGraceMs = 5000, cleanupGraceMs = 2000, heartbeatTimeoutMs = 90000 }) {
  let active = null;
  const kill = child => { try { child.kill(); } catch {} };
  function schedule() {
    if (active) return;
    const task = [...listTasks()].reverse().find(item => item.status === 'queued');
    if (!task) return;
    let child;
    try { child = spawnWorker(); }
    catch (error) { patchTask(task.id, { status: 'failed', stage: 'failed', message: `无法启动处理进程：${error.message}` }); queueMicrotask(schedule); return; }
    const slot = { id: task.id, child, done: false, exited: false, heartbeat: Date.now(), cancelTimer: null, cleanupTimer: null, watchdog: null };
    active = slot;
    patchTask(task.id, { status: 'running', startedAt: new Date().toISOString(), workerPid: child.pid, message: task.cacheId ? '从已保存素材和处理进度继续' : '正在准备处理' });
    const finish = (patch, stop = false) => {
      if (slot.done) return;
      slot.done = true;
      clearInterval(slot.watchdog); clearTimeout(slot.cancelTimer);
      patchTask(task.id, patch);
      if (active === slot) active = null;
      // A finished OCR worker may keep a native thread alive. Never hold the queue for it.
      if (stop) kill(child);
      else if (!slot.exited) { slot.cleanupTimer = setTimeout(() => kill(child), cleanupGraceMs); slot.cleanupTimer.unref?.(); }
      queueMicrotask(schedule);
    };
    slot.finish = finish;
    const settleExit = async (code, signal, error) => {
      if (slot.done) return;
      const saved = await recover(task.id);
      if (slot.done) return;
      const cancelling = getTask(task.id)?.status === 'cancelling';
      finish(saved || { status: cancelling ? 'cancelled' : 'failed', stage: cancelling ? 'cancelled' : 'failed', message: cancelling ? '任务已取消，已保存步骤可在重试时复用' : `处理进程退出（code=${code ?? '无'}，signal=${signal || '无'}）${error ? `：${error.message}` : ''}；已完成步骤保留，可继续处理。`, workerExitCode: code, workerExitSignal: signal, finishedAt: new Date().toISOString() }, true);
    };
    child.stderr?.on('data', chunk => { const text = chunk.toString(); if (!text.includes('ExperimentalWarning')) log(text.slice(0, 600)); });
    child.on('message', message => {
      if (slot.done) return;
      slot.heartbeat = Date.now();
      if (message.type === 'heartbeat') return;
      if (message.type === 'progress') {
        if (getTask(task.id)?.status !== 'cancelling') patchTask(task.id, message.patch);
      }
      if (message.type === 'done') finish(message.patch);
    });
    child.on('error', error => { void settleExit(null, null, error); });
    child.on('exit', (code, signal) => { slot.exited = true; clearTimeout(slot.cleanupTimer); void settleExit(code, signal); });
    slot.watchdog = setInterval(() => {
      if (Date.now() - slot.heartbeat > heartbeatTimeoutMs) finish({ status: 'failed', stage: 'failed', message: '处理进程长时间无响应，已停止并释放队列；已完成步骤可继续。', finishedAt: new Date().toISOString() }, true);
    }, Math.max(10, Math.min(5000, heartbeatTimeoutMs / 3)));
    try { child.send({ type: 'start', task }, error => { if (error) void settleExit(null, null, error); }); }
    catch (error) { void settleExit(null, null, error); }
  }
  function cancel(id) {
    const task = getTask(id);
    if (task?.status === 'queued') { patchTask(id, { status: 'cancelled', stage: 'cancelled', message: '任务已取消' }); return; }
    const slot = active;
    if (!slot || slot.id !== id || slot.done) return;
    patchTask(id, { status: 'cancelling', message: '正在取消，最多数秒后释放队列；已保存进度可复用' });
    if (slot.cancelTimer) return;
    slot.cancelTimer = setTimeout(() => {
      if (slot.done) return;
      // Terminate an unresponsive child. Its exit handler recovers a saved result,
      // otherwise records cancellation and releases the queue.
      slot.finish({ status: 'cancelled', stage: 'cancelled', message: '任务已取消，已释放队列；已完成步骤会在重试时复用。', finishedAt: new Date().toISOString(), forcedCancellation: true }, true);
    }, cancelGraceMs);
    try { slot.child.send({ type: 'cancel' }, () => {}); } catch {}
  }
  return { schedule, cancel, get active() { return active; } };
}
