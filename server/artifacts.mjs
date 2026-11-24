import { readFile, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { taskDirectory, patchTask } from './store.mjs';
import { ARTIFACT_VERSION, writeTeachingArtifacts } from './teaching-artifacts.mjs';
import { inspectRefinements } from './refine.mjs';

const exists = async file => { try { await access(file); return true; } catch { return false; } };
export async function taskArtifacts(task) {
  const directory = taskDirectory(task.id);
  const documents = [];
  for (const name of ['视频重点.md', '精简讲稿.md', '视频信息整理.md', '视频解析.md', '学习笔记.md', '教学讲稿.md']) if (await exists(path.join(directory, name))) documents.push(name);
  let artifactStatus = null, keyframes = [], errors = [];
  try { artifactStatus = JSON.parse(await readFile(path.join(directory, '产物状态.json'), 'utf8')); } catch {}
  try {
    const index = JSON.parse(await readFile(path.join(directory, '关键图片.json'), 'utf8'));
    for (const frame of index.frames || []) if (/^keyframes\/frame-\d+\.png$/.test(frame.keyFile) && await exists(path.join(directory, frame.keyFile))) keyframes.push(frame);
  } catch {}
  try {
    const progress = JSON.parse(await readFile(path.join(directory, 'analysis-progress.json'), 'utf8'));
    errors = progress.batches.flatMap(batch => [
      ...(batch.status === 'failed' ? [{ batch: batch.id, stage: '图片分析', message: batch.error, imageCount: batch.files?.length || 0 }] : []),
      ...(batch.lesson?.status === 'failed' ? (batch.lesson.groups || []).filter(group => group.status === 'failed').map(group => ({ batch: batch.id, stage: '教学讲稿', message: group.error, imageCount: 0 })) : []),
    ]);
  } catch {}
  return { documents, artifactStatus, keyframes, errors, refinement: await inspectRefinements(directory, { sourcePartial: task.result?.fullPlayback === false }) };
}

export async function restoreSavedArtifacts(task) {
  if (!task.result || !['completed', 'partial', 'failed', 'cancelled'].includes(task.status)) return;
  const directory = taskDirectory(task.id);
  const current = await taskArtifacts(task);
  if (current.artifactStatus?.formatVersion === ARTIFACT_VERSION) return;
  let state, media;
  try {
    state = JSON.parse(await readFile(path.join(directory, 'analysis-progress.json'), 'utf8'));
    media = JSON.parse(await readFile(path.join(directory, 'acquisition.json'), 'utf8'));
  } catch { return; }
  if (!state.batches?.some(batch => batch.status === 'completed' && batch.output?.frames)) return;
  // Preserve original locally extracted notes before restoring model-derived text.
  if (!await exists(path.join(directory, '本地整理.md')) && await exists(path.join(directory, '学习笔记.md'))) await copyFile(path.join(directory, '学习笔记.md'), path.join(directory, '本地整理.md'));
  const artifacts = await writeTeachingArtifacts(directory, media, task.result.frames || media.frames, state, task.model || task.result.model, { allowLegacyDrafts: true });
  if (artifacts) patchTask(task.id, { result: { ...task.result, ...artifacts }, artifactRestore: 'saved-evidence-only' });
}
