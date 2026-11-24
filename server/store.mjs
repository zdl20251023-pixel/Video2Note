import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVideoUrl } from './platforms.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL = path.join(process.env.VIDEO2NOTE_DATA_ROOT || ROOT, '.local');
export const OUTPUT = path.join(process.env.VIDEO2NOTE_DATA_ROOT || ROOT, 'artifacts', 'tasks');
mkdirSync(LOCAL, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });
const db = new DatabaseSync(path.join(LOCAL, 'tasks.sqlite'));
db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS refinement_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
export const getRefinementJob = id => { const row = db.prepare('SELECT data FROM refinement_jobs WHERE id = ?').get(id); return row ? JSON.parse(row.data) : null; };
export const listRefinementJobs = () => db.prepare('SELECT data FROM refinement_jobs ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
export function saveRefinementJob(job) {
  db.prepare('INSERT INTO refinement_jobs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job));
  return job;
}
export function patchRefinementJob(id, patch) {
  const previous = getRefinementJob(id);
  if (!previous) throw new Error('精简任务不存在');
  return saveRefinementJob({ ...previous, ...patch, updatedAt: new Date().toISOString() });
}
export const refinementJobDirectory = id => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效精简任务编号');
  return path.join(LOCAL, 'refinement-jobs', id);
};
export const getTask = id => {
  const row = db.prepare('SELECT data FROM tasks WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
};
export const listTasks = () => db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
export function saveTask(task) {
  db.prepare('INSERT INTO tasks(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task));
  return task;
}
export function patchTask(id, patch) {
  const previous = getTask(id);
  if (!previous) throw new Error('任务不存在');
  return saveTask({ ...previous, ...patch, updatedAt: new Date().toISOString() });
}
export function normalizeUrl(value) {
  return parseVideoUrl(value).url;
}
export function taskDirectory(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效任务编号');
  const named = readdirSync(OUTPUT, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.endsWith(`_${id}`));
  if (named) return path.join(OUTPUT, named.name);
  return path.join(OUTPUT, id);
}
export function titleDirectoryName(title, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效任务编号');
  const cleaned = String(title || '未命名视频').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  // Keep the complete UUID and leave room for nested files on Windows.
  const name = Array.from(cleaned || '未命名视频').slice(0, 65).join('').replace(/[. ]+$/g, '');
  return `${name}_${id}`;
}
export function nameTaskDirectory(id, title) {
  const original = taskDirectory(id), target = path.join(OUTPUT, titleDirectoryName(title, id));
  if (original !== target) renameSync(original, target);
  return target;
}
export function safeOutputPath(id, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) throw new Error('无效文件路径');
  const root = taskDirectory(id);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error('无效文件路径');
  return target;
}
