import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import { planAnalysis, generateTeaching, selectKeyframes, validateBatch, validateSegments, normalizeSourceType, validateCourse } from '../server/teaching.mjs';
import { extractFrames, runProcess } from '../server/public-media.mjs';
import { taskDirectory, nameTaskDirectory, titleDirectoryName, safeOutputPath, OUTPUT } from '../server/store.mjs';
import { writeTeachingArtifacts } from '../server/teaching-artifacts.mjs';
import { teachingReply, state } from './teaching-fixture.mjs';

const snapshot = { providerId: 'mock', providerLabel: 'Mock', modelId: 'mock', modelLabel: 'Mock', vision: true, maxInputChars: 24000, maxOutputTokens: 12000, maxImagesPerBatch: 4 };
const noop = () => {};
async function fixture(count = 15) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-teaching-'));
  await mkdir(path.join(directory, 'images')); await mkdir(path.join(directory, 'captions'));
  await writeFile(path.join(directory, 'captions/zh.vtt'), 'WEBVTT\n\n00:00:03.000 --> 00:00:06.000\n翻牌前先确认位置与底池。\n\n00:01:00.000 --> 00:01:03.000\n河牌需要考虑对手范围。\n');
  const frames = [];
  for (let i = 0; i < count; i++) {
    const frame = { time: i * 5, file: `images/frame-${String(i + 1).padStart(3, '0')}.png`, text: '', confidence: 0 };
    await writeFile(path.join(directory, frame.file), `image-${i}`); frames.push(frame);
  }
  return { directory, frames, media: { title: '河牌加注教学', url: 'https://www.youtube.com/watch?v=abc', coveredSeconds: 90, duration: 90, fullPlayback: true, captions: { zh: 'captions/zh.vtt' }, warnings: [] }, local: { language: 'zh', markdown: '本地原文整理' } };
}

test('planner covers 101 images and all captions, including images in caption gaps', () => {
  const frames = Array.from({ length: 101 }, (_, i) => ({ time: i * 3, file: `images/frame-${i}.png`, bytes: 100 }));
  const cues = [{ start: 8, end: 10, text: '开场' }, { start: 240, end: 250, text: '结尾' }];
  const batches = planAnalysis(cues, frames, 10000, 6, 1000);
  assert.deepEqual(batches.flatMap(batch => batch.frames), frames);
  assert.deepEqual(batches.flatMap(batch => batch.cues), cues);
  assert.ok(batches.every(batch => batch.frames.length <= 6));
});

test('failed batches resume without resending successful images; all images and teaching documents survive', async () => {
  const f = await fixture();
  const delivered = [], updates = [];
  let fail = true;
  const invoke = async (_snapshot, messages) => {
    if (Array.isArray(messages[1].content)) {
      const metadata = JSON.parse(messages[1].content[0].text.split('本批次证据：')[1]);
      if (fail && metadata.frames.some(frame => frame.file.endsWith('005.png'))) throw new Error('模拟超时');
      delivered.push(...metadata.frames.map(frame => frame.file));
    }
    return { text: JSON.stringify(teachingReply(messages)), usage: { total_tokens: 10 } };
  };
  const options = { includeImages: true, report: patch => updates.push(patch), checkCancelled: noop, invoke };
  try {
    await assert.rejects(generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, options), /重试失败批次/);
    const checkpoint = JSON.parse(await readFile(path.join(f.directory, 'analysis-progress.json'), 'utf8'));
    assert.equal(checkpoint.coverage.analyzed, 11); assert.equal(checkpoint.coverage.failed, 4);
    fail = false;
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, options);
    assert.equal(result.analysis.analyzed, 15); assert.equal(result.analysis.failed, 0);
    assert.equal(new Set(delivered).size, 15); assert.equal(delivered.length, 15);
    assert.equal(result.keyframes.length, 15);
    assert.equal((await readdir(path.join(f.directory, 'keyframes'))).filter(name => name.endsWith('.png')).length, 15);
    const lesson = await readFile(path.join(f.directory, '教学讲稿.md'), 'utf8');
    assert.match(lesson, /动画动作与画面顺序/); assert.match(lesson, /教学旁白/); assert.match(lesson, /keyframes\/frame-015.png/);
    const scenes = JSON.parse(await readFile(path.join(f.directory, '教学分镜.json'), 'utf8'));
    assert.ok(scenes.segments.every(segment => segment.sourceType && segment.keyImages.length));
    assert.ok(updates.some(update => update.analysis?.failed === 4));
    // Changing model invalidates the cache rather than silently using old results.
    const before = delivered.length;
    await generateTeaching(f.directory, f.media, f.frames, f.local, { ...snapshot, modelId: 'changed' }, options);
    assert.equal(delivered.length - before, 15);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('provider image limits split a batch recursively without dropping images', async () => {
  const f = await fixture(7), delivered = [];
  try {
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      const content = messages[1].content;
      if (Array.isArray(content)) {
        const count = content.filter(part => part.type === 'image_url').length;
        if (count > 2) { const error = new Error('请求过大'); error.httpStatus = 413; throw error; }
        delivered.push(...JSON.parse(content[0].text.split('本批次证据：')[1]).frames.map(frame => frame.file));
      }
      return { text: JSON.stringify(teachingReply(messages)) };
    } });
    assert.equal(result.analysis.analyzed, 7); assert.equal(new Set(delivered).size, 7);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('duplicate decisions retain changes in pot, suits, action and uncertain state', () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({ file: `images/frame-${i}.png`, digest: `hash-${i}`, time: i, text: '' }));
  const analyses = frames.map((frame, i) => ({ file: frame.file, state: { ...state }, description: '画面', reason: '测试', duplicateOf: i ? frames[i - 1].file : null }));
  analyses[2].state.pot = '6 BB';
  analyses[3].state.board = 'As7h2c4s9h';
  analyses[4].state.actions = 'BB bet 1 BB';
  analyses[5].state.pot = '未知';
  const selected = selectKeyframes(frames, analyses);
  assert.equal(selected.selected.length, 5);
  assert.equal(selected.decisions[1].duplicateOf, frames[0].file);
  assert.ok(selected.decisions.slice(2).every(frame => frame.duplicateOf === null));
});

test('missing frame analysis, unsupported vision and invalid evidence cannot claim completeness', async () => {
  const f = await fixture(2);
  try {
    await assert.rejects(generateTeaching(f.directory, f.media, f.frames, f.local, { ...snapshot, vision: false }, { includeImages: true, report: noop, checkCancelled: noop }), /不支持图片/);
    const batch = { frames: f.frames, cues: [] };
    assert.throws(() => validateBatch(JSON.stringify({ ...teachingReply([{},{content:[{type:'text',text:`本批次证据：${JSON.stringify({ ...batch, maxTime:90 })}`}]}]), frames: [] }), batch, 90), /全部截图/);
    await assert.rejects(generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      const reply = teachingReply(messages); reply.segments[0].evidenceFiles = ['images/frame-999.png']; return { text: JSON.stringify(reply) };
    } }), /未完成/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('title directory resolution preserves legacy paths and prevents traversal', async () => {
  const id = randomUUID(), legacy = taskDirectory(id);
  try {
    await mkdir(legacy);
    assert.equal(taskDirectory(id), legacy);
    const named = nameTaskDirectory(id, '../A:为什么?<>"|'.repeat(15));
    assert.equal(taskDirectory(id), named);
    assert.ok(named.startsWith(OUTPUT + path.sep));
    assert.ok(path.basename(named).endsWith(`_${id}`));
    assert.ok(path.basename(named).length < 180);
    assert.equal(safeOutputPath(id, '教学讲稿.md'), path.join(named, '教学讲稿.md'));
    assert.throws(() => safeOutputPath(id, '../secret'), /无效文件路径/);
    assert.match(titleDirectoryName('', id), /未命名视频/);
  } finally { await rm(taskDirectory(id), { recursive: true, force: true }); }
});

test('actual FFmpeg extraction honors 3 seconds beyond the former 60-frame limit', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-sampling-'));
  try {
    await mkdir(path.join(directory, 'images'));
    const source = 'source.mp4';
    const video = await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=1:d=184', path.join(directory, source)]);
    assert.equal(video.code, 0);
    const frames = await extractFrames(directory, source, 184, 3, noop, noop);
    assert.equal(frames.length, 62); assert.equal(frames[0].time, 0); assert.equal(frames.at(-1).time, 183);
    assert.equal((await readdir(path.join(directory, 'images'))).length, 62);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image-only facts enter information and then the separate teaching input, with text links instead of embedded galleries', async () => {
  const f = await fixture(1);
  const lessonInputs = [];
  try {
    const result = await generateTeaching(f.directory, { ...f.media, captions: {} }, f.frames, { ...f.local, language: null }, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      if (messages[1].content.startsWith?.('讲稿依据：')) lessonInputs.push(messages[1].content);
      return { text: JSON.stringify(teachingReply(messages)) };
    } });
    assert.ok(lessonInputs.some(input => input.includes('7♦9♦') && input.includes('streetTimeline') && input.includes('1.5万')));
    const information = await readFile(path.join(f.directory, '视频信息整理.md'), 'utf8');
    const lesson = await readFile(path.join(f.directory, '教学讲稿.md'), 'utf8');
    for (const word of ['翻前', '翻牌', '转牌', '河牌', '7♦9♦', '1.5万', '半池']) assert.ok(information.includes(word), word);
    assert.match(lesson, /7♦9♦/);
    assert.doesNotMatch(information, /!\[/); assert.doesNotMatch(lesson, /!\[/);
    assert.match(information, /\[查看对应图片\]\(keyframes\/frame-001.png\)/);
    assert.equal(result.artifactStatus.lesson, 'complete');
    assert.ok(result.documents.includes('视频信息整理.md') && result.documents.includes('教学讲稿.md'));
    const image = await readFile(path.join(f.directory, 'keyframes/frame-001.png'));
    assert.deepEqual(image, await readFile(path.join(f.directory, 'images/frame-001.png')));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('lesson failure preserves information and keyframes; retry only repeats failed teaching groups', async () => {
  const f = await fixture(3);
  let failed = true, imageCalls = 0;
  const invoke = async (_snapshot, messages) => {
    if (Array.isArray(messages[1].content)) imageCalls++;
    if (failed && messages[1].content.startsWith?.('讲稿依据：')) throw new Error('模拟讲稿接口失败');
    return { text: JSON.stringify(teachingReply(messages)) };
  };
  const options = { includeImages: true, report: noop, checkCancelled: noop, invoke };
  try {
    let error;
    try { await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, options); } catch (caught) { error = caught; }
    assert.match(error.message, /教学讲稿尚未完成/);
    assert.equal(error.artifacts.keyframes.length, 3);
    assert.equal(error.artifacts.artifactStatus.information, 'complete');
    assert.equal(error.artifacts.artifactStatus.lesson, 'missing');
    assert.ok((await readFile(path.join(f.directory, '视频信息整理.md'), 'utf8')).includes('场景与牌局背景'));
    assert.equal((await readdir(path.join(f.directory, 'keyframes'))).filter(name => name.endsWith('.png')).length, 3);
    failed = false;
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, options);
    assert.equal(imageCalls, 1);
    assert.equal(result.artifactStatus.lesson, 'complete');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('historical analysis can restore partial documents and an independent keyframe folder without model calls', async () => {
  const f = await fixture(2);
  try {
    const batch = { cues: [], frames: f.frames, maxTime: 90 };
    const output = teachingReply([{}, { content: [{ type: 'text', text: `本批次证据：${JSON.stringify(batch)}` }] }]);
    output.frames.forEach(frame => { delete frame.background; delete frame.streetTimeline; });
    const state = { imageMode: 'vision', batches: [{ id: 1, files: f.frames.map(frame => frame.file), status: 'completed', output }, { id: 2, files: ['images/frame-003.png'], status: 'failed', error: '原讲稿时间戳校验失败' }] };
    const result = await writeTeachingArtifacts(f.directory, f.media, f.frames, state, snapshot, { allowLegacyDrafts: true });
    assert.equal(result.keyframes.length, 2);
    assert.equal(result.artifactStatus.information, 'partial');
    assert.equal(result.artifactStatus.lesson, 'partial');
    assert.equal(result.artifactStatus.visualDetails, 'legacy');
    const lesson = await readFile(path.join(f.directory, '教学讲稿.md'), 'utf8');
    assert.match(lesson, /历史草稿/); assert.match(lesson, /原讲稿时间戳校验失败/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('overview screenshot source anchors correct misplaced lesson timestamps without rejecting image analysis', () => {
  const batch = { cues: [], frames: [{ file: 'images/frame-001.png', time: 360 }] };
  const response = teachingReply([{}, { content: '讲稿依据：' + JSON.stringify({ evidenceFrames: batch.frames, cueRange: [] }) }]);
  response.segments[0].timeSeconds = 12;
  const segments = validateSegments(JSON.stringify(response), batch, 400);
  assert.equal(segments[0].timeSeconds, 360);
  assert.equal(segments[0].reportedTimeSeconds, 12);
  assert.ok(segments[0].uncertainties.some(value => value.includes('来源时间')));
  response.segments[0].evidenceFiles = [];
  assert.throws(() => validateSegments(JSON.stringify(response), batch, 400), /没有可定位的图片证据/);
});

test('source labels tolerate aliases, missing and mixed attributions without fabricating a factual source', () => {
  assert.equal(normalizeSourceType('画面事实').value, '画面可见事实');
  assert.equal(normalizeSourceType('讲师观点').value, '原作者观点');
  for (const raw of [undefined, '', '画面可见事实/原作者观点/模型推断', '事实与讲师推论', '__proto__']) {
    const result = normalizeSourceType(raw);
    assert.equal(result.value, '待核对'); assert.ok(result.warning && result.raw);
  }
  const batch = { frames: [{ file: 'images/frame-001.png', time: 1 }], cues: [], maxTime: 10 };
  const response = teachingReply([{}, { content: [{ type: 'text', text: `本批次证据：${JSON.stringify(batch)}` }] }]);
  response.frames[0].streetTimeline[0].sourceType = '画面可见事实/原作者观点';
  const output = validateBatch(JSON.stringify(response), batch, 10);
  assert.equal(output.frames[0].streetTimeline[0].sourceType, '待核对');
  assert.equal(output.frames[0].streetTimeline[0].sourceTypeRaw, '画面可见事实/原作者观点');
  assert.ok(output.frames[0].uncertainties.some(value => value.includes('来源标签')));
  assert.equal(output.frames[0].streetTimeline[0].amounts, response.frames[0].streetTimeline[0].amounts);
});

test('invalid model output is saved for diagnosis before rejecting missing image evidence', async () => {
  const f = await fixture(1);
  try {
    await assert.rejects(generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      const response = teachingReply(messages); response.frames = []; return { text: JSON.stringify(response) };
    } }), /图片分析批次未完成/);
    const diagnostics = await readdir(path.join(f.directory, 'analysis-responses'));
    assert.equal(diagnostics.length, 1);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'analysis-responses', diagnostics[0]), 'utf8'));
    assert.equal(JSON.parse(saved.responseText).frames.length, 0);
    assert.deepEqual(saved.files, ['images/frame-001.png']);
    assert.ok(!Object.hasOwn(saved, 'headers'));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('course lists accept scalar and structured model output, preserving more than 30 entries', () => {
  const data = { title: '完整课程', overview: '按图片与语音整理的背景', objectives: '理解河牌范围', prerequisites: { text: '理解位置' }, review: Array.from({ length: 45 }, (_, index) => `复习问题 ${index}`), uncertainties: null };
  const course = validateCourse(JSON.stringify(data));
  assert.deepEqual(course.objectives, ['理解河牌范围']); assert.equal(course.review.length, 45);
  assert.ok(course.prerequisites[0].includes('理解位置'));
  assert.ok(course.uncertainties.some(value => value.includes('格式') || value.includes('字段')));
});

test('transient provider failure retries automatically without discarding the successful analysis', async () => {
  const f = await fixture(1); let attempts = 0;
  try {
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      if (Array.isArray(messages[1].content) && ++attempts === 1) { const error = new Error('调用过于频繁'); error.httpStatus = 429; throw error; }
      return { text: JSON.stringify(teachingReply(messages)) };
    } });
    assert.equal(attempts, 2); assert.equal(result.analysis.analyzed, 1); assert.equal(result.artifactStatus.lesson, 'complete');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('optional lecture fields can be empty and paragraphs can be arrays; narration remains required', () => {
  const batch = { frames: [{ file: 'images/frame-001.png', time: 5 }], cues: [] };
  const response = teachingReply([{}, { content: '讲稿依据：' + JSON.stringify({ evidenceFrames: batch.frames, cueRange: [] }) }]);
  response.segments[0].question = null; response.segments[0].prerequisites = '  '; response.segments[0].narration = ['第一段旁白', '第二段旁白'];
  const segments = validateSegments(JSON.stringify(response), batch, 10);
  assert.equal(segments[0].narration, '第一段旁白\n第二段旁白'); assert.ok(segments[0].uncertainties.some(value => value.includes('question')));
  response.segments[0].narration = null;
  assert.throws(() => validateSegments(JSON.stringify(response), batch, 10), /narration/);
});

test('malformed teaching narration is corrected once without redoing image analysis', async () => {
  const f = await fixture(1); let imageCalls = 0, lectureCalls = 0;
  try {
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, snapshot, { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
      let input = messages;
      if (Array.isArray(messages[1].content)) imageCalls++;
      if (messages[1].content.startsWith?.('讲稿依据：')) {
        lectureCalls++;
        input = structuredClone(messages); input[1].content = input[1].content.split('\n上次结构校验失败：')[0];
      }
      const reply = teachingReply(input);
      if (lectureCalls === 1 && messages[1].content.startsWith?.('讲稿依据：')) reply.segments[0].narration = null;
      return { text: JSON.stringify(reply) };
    } });
    assert.equal(imageCalls, 1); assert.equal(lectureCalls, 2); assert.equal(result.artifactStatus.lesson, 'complete');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('successful course merge requests are checkpointed and skipped after a later course failure', async () => {
  const f = await fixture(3); let failing = true, imageCalls = 0; const courseCalls = new Map();
  const options = { includeImages: true, report: noop, checkCancelled: noop, invoke: async (_snapshot, messages) => {
    const content = messages[1].content;
    if (Array.isArray(content)) imageCalls++;
    else if (!content.startsWith('讲稿依据：')) {
      courseCalls.set(content, (courseCalls.get(content) || 0) + 1);
      if (failing && courseCalls.size === 2) throw new Error('模拟课程汇总失败');
    }
    return { text: JSON.stringify(teachingReply(messages)) };
  } };
  try {
    await assert.rejects(generateTeaching(f.directory, f.media, f.frames, f.local, { ...snapshot, maxInputChars: 10000 }, options), /课程结构汇总未完成/);
    const firstInput = courseCalls.keys().next().value;
    failing = false;
    const result = await generateTeaching(f.directory, f.media, f.frames, f.local, { ...snapshot, maxInputChars: 10000 }, options);
    assert.equal(courseCalls.get(firstInput), 1); assert.equal(imageCalls, 1); assert.equal(result.artifactStatus.lesson, 'complete');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
