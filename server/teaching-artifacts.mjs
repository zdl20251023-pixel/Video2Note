import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { stamp } from './notes.mjs';

export const ARTIFACT_VERSION = 2;
const md = value => String(value ?? '未提供').replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
export const stateLabels = { positions: '人物与位置', holeCards: '手牌及花色', board: '公共牌及花色', pot: '底池与单位', stacks: '筹码与单位', actions: '行动与下注', overlays: '画面教学文字' };

export function selectKeyframes(frames, analyses) {
  const records = new Map(analyses.map(frame => [frame.file, frame]));
  const selected = [], decisions = [], byFile = new Map();
  for (const frame of [...frames].sort((a, b) => a.time - b.time)) {
    const analysis = records.get(frame.file);
    if (!analysis) throw new Error('关键图片筛选缺少截图分析记录');
    const prior = selected.at(-1);
    const sameBytes = prior && frame.digest && frame.digest === prior.digest;
    const reliable = Object.values(analysis.state || {}).length === 7 && Object.values(analysis.state).every(value => !/未知|待核对|不清|不明|无法|缺失/.test(value));
    const referenced = decisions.find(item => item.file === analysis.duplicateOf);
    const sameTimeline = prior && JSON.stringify(analysis.streetTimeline || []) === JSON.stringify(prior.streetTimeline || []);
    const semanticDuplicate = prior && referenced?.keyFile === prior.keyFile && reliable && sameTimeline && JSON.stringify(analysis.state) === JSON.stringify(prior.state) && (frame.text || '') === (prior.text || '');
    const duplicate = sameBytes || semanticDuplicate;
    const record = { ...frame, ...analysis, duplicateOf: duplicate ? prior.file : null, keyFile: duplicate ? prior.keyFile : frame.file.replace(/^images\//, 'keyframes/') };
    if (!duplicate) selected.push(record);
    byFile.set(frame.file, record.keyFile); decisions.push(record);
  }
  return { selected, decisions, byFile };
}

export function frameInformation(frame, heading = '###') {
  const lines = [`${heading} ${stamp(frame.time)} · ${md(frame.description)}`, '', `场景与牌局背景：${md(frame.background || '旧版分析未单列背景，请结合下列已保存的牌局状态核对。')}`, '', '画面可见事实：', '', ...Object.entries(frame.state || {}).map(([key, value]) => `- ${stateLabels[key] || md(key)}：${md(value)}`), ''];
  if (frame.visualFacts?.length) lines.push(...frame.visualFacts.map(value => `- ${md(value)}`), '');
  if (frame.streetTimeline?.length) {
    lines.push('逐街过程（画面回顾内容，不等同于截图发生时间）：', '');
    for (const street of frame.streetTimeline) lines.push(`- **${md(street.street)}**：${md(street.players)}；牌面：${md(street.board)}；行动：${md(street.actions)}；数额：${md(street.amounts)}；视频评价：${md(street.commentary)}（${md(street.sourceType)}）`, '');
  }
  lines.push(`教学意义：${md(frame.teachingMeaning || frame.reason)}`, '', `保留原因：${md(frame.reason)}`, '', ...((frame.uncertainties || []).map(value => `- 待核对：${md(value)}`)), '', `[查看对应图片](${frame.keyFile || frame.file})`, '');
  return lines;
}

// Render saved model evidence without another paid model request. Partial evidence remains useful.
export async function writeTeachingArtifacts(directory, media, frames, state, snapshot, { allowLegacyDrafts = false } = {}) {
  const completed = state.batches.filter(batch => batch.status === 'completed' && batch.output);
  if (!completed.length) return null;
  const analyses = completed.flatMap(batch => batch.output.frames);
  const files = new Set(analyses.map(frame => frame.file));
  const prepared = [];
  for (const frame of frames.filter(frame => files.has(frame.file))) {
    const bytes = await readFile(path.join(directory, frame.file));
    prepared.push({ ...frame, digest: createHash('sha256').update(bytes).digest('hex') });
  }
  const imageMode = state.imageMode === 'vision';
  const keyframes = imageMode ? selectKeyframes(prepared, analyses) : { selected: [], decisions: [], byFile: new Map() };
  await mkdir(path.join(directory, 'keyframes'), { recursive: true });
  for (const frame of keyframes.selected) await copyFile(path.join(directory, frame.file), path.join(directory, frame.keyFile));
  const analysisComplete = completed.length === state.batches.length;
  const course = state.course || { title: media.title, overview: '全片结构尚未完成汇总，以下保留已完成批次的原始分析。', objectives: [], prerequisites: [], review: [], uncertainties: [] };
  const missing = state.batches.filter(batch => batch.status !== 'completed').map(batch => `批次 ${batch.id}：${batch.error || '尚未完成'}，涉及 ${(batch.files || []).length} 张截图`);
  const legacy = completed.some(batch => batch.output.frames.some(frame => !frame.background || !Array.isArray(frame.streetTimeline)));
  const sections = completed.map(batch => ({ batch, segments: batch.lesson?.segments || (allowLegacyDrafts ? batch.output.segments || [] : []) }));
  const lessonComplete = media.fullPlayback && analysisComplete && !!state.course && sections.every(section => section.batch.lesson?.status === 'completed');
  const segments = sections.flatMap(section => section.segments).sort((a, b) => a.timeSeconds - b.timeSeconds).map((segment, index) => ({ ...segment, id: index + 1, keyImages: [...new Set((segment.evidenceFiles || []).map(file => keyframes.byFile.get(file)).filter(Boolean))] }));
  const provenance = [`来源：${media.url}`, `模型：${md(snapshot?.providerLabel || '原任务模型')} / ${md(snapshot?.modelId || '原任务模型')}`, `视频覆盖：${stamp(media.coveredSeconds)} / ${stamp(media.duration)}；${media.fullPlayback ? '完整提取' : '部分内容'}`, `图片分析：${imageMode ? `${prepared.length}/${frames.length} 张` : '已关闭，以下仅整理文字证据'}`, `信息状态：${analysisComplete ? '批次分析完成' : '部分内容，尚未完成全部分析'}`, ...(legacy ? ['旧版结果提示：已恢复保存的分析，尚未完成新版逐图背景及逐街结构化识别；请重新整理以补齐。'] : []), '原作者观点、模型推断与教学改编均需核对；未知牌面和数字不补造。', ...missing, ...(media.warnings || []).map(warning => `提示：${md(warning)}`)].join('\n\n');
  const info = [`# ${md(media.title)} · 视频信息整理`, '', provenance, '', '## 背景与核心问题', '', md(course.overview), ''];
  for (const batch of completed) {
    const output = batch.output;
    info.push(`## 第 ${batch.id} 段 · 信息整理`, '', '### 场景与牌局背景', '', md(output.background), '', '### 语音讲解整理', '', md(output.narration), '', '### 策略、理由、适用条件与来源冲突', '', md(output.strategy), '', ...(output.uncertainties || []).map(value => `- 待核对：${md(value)}`), '');
    for (const frame of output.frames) {
      const original = prepared.find(item => item.file === frame.file);
      if (original) info.push(...frameInformation({ ...original, ...frame, keyFile: keyframes.byFile.get(frame.file) }));
    }
  }
  info.push('## 待核对与复习', '', ...(course.uncertainties || []).map(value => `- 待核对：${md(value)}`), ...(course.review || []).map(value => `- ${md(value)}`));
  await writeFile(path.join(directory, '视频信息整理.md'), info.join('\n'));
  // Compatibility names contain the same text-only material, never embedded image galleries.
  for (const name of ['学习笔记.md', '视频解析.md']) await writeFile(path.join(directory, name), info.join('\n'));
  const imageIndex = { mode: imageMode ? 'model' : 'disabled', complete: analysisComplete, analyzed: prepared.length, total: frames.length, frames: keyframes.selected, decisions: keyframes.decisions };
  await writeFile(path.join(directory, '关键图片.json'), JSON.stringify(imageIndex, null, 2));
  await writeFile(path.join(directory, 'keyframes/说明.md'), [`# 关键图片说明`, '', provenance, '', ...keyframes.selected.flatMap(frame => frameInformation(frame))].join('\n'));
  const documents = ['视频信息整理.md'];
  if (segments.length) {
    const lesson = [`# ${md(course.title)} · 教学讲稿`, '', `讲稿状态：${lessonComplete ? '完整讲稿' : '部分讲稿 / 历史草稿，尚未完成全部生成与核对'}`, '', provenance, '', '## 学习目标', '', ...(course.objectives || []).map(value => `- ${md(value)}`), '', '## 前置知识', '', ...(course.prerequisites || []).map(value => `- ${md(value)}`), '', '## 课程结构', '', md(course.overview), ''];
    for (const segment of segments) lesson.push(`## 分镜 ${segment.id} · ${stamp(segment.timeSeconds)} · ${md(segment.title)}`, '', `内容类型：${md(segment.sourceType)}；来源截图/字幕时间：${stamp(segment.timeSeconds)}`, '', `学习目标：${md(segment.objective)}`, '', `前置知识：${md(segment.prerequisites)}`, '', '### 初始牌桌状态', '', md(segment.initialState), '', '### 动画动作与画面顺序', '', md(segment.actions), '', '### 教学旁白', '', md(segment.narration), '', '### 屏幕标注', '', md(segment.annotations), '', '### 决策问题与常见误区', '', md(segment.question), '', ...(segment.uncertainties || []).map(value => `- 待核对：${md(value)}`), '', ...segment.keyImages.map(file => `[查看分镜图片证据](${file})`), '');
    lesson.push('## 课后复习与总结', '', ...(course.review || []).map(value => `- ${md(value)}`), '', '## 全局待核对', '', ...(course.uncertainties || []).map(value => `- ${md(value)}`));
    await writeFile(path.join(directory, '教学讲稿.md'), lesson.join('\n'));
    await writeFile(path.join(directory, '教学分镜.json'), JSON.stringify({ complete: lessonComplete, course, segments }, null, 2));
    documents.push('教学讲稿.md');
  }
  const artifactStatus = { formatVersion: ARTIFACT_VERSION, information: analysisComplete ? 'complete' : 'partial', lesson: lessonComplete ? 'complete' : segments.length ? 'partial' : 'missing', visualDetails: legacy ? 'legacy' : 'structured', keyframes: keyframes.selected.length, missingBatches: missing, documents };
  await writeFile(path.join(directory, '产物状态.json'), JSON.stringify(artifactStatus, null, 2));
  return { noteMode: 'model-semantic', documents, keyframes: keyframes.selected, artifactStatus, model: { providerId: snapshot?.providerId, providerLabel: snapshot?.providerLabel, modelId: snapshot?.modelId, modelLabel: snapshot?.modelLabel, imagesSent: imageMode ? prepared.length : 0 } };
}
