import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSubtitleEncoding } from './captions.mjs';

export const stamp = seconds => {
  const n = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(v => String(v).padStart(2, '0')).join(':');
};
const escape = value => String(value).replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
function seconds(text) {
  return text.replace(',', '.').split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
export function parseVtt(text) {
  const cues = [];
  for (const block of normalizeSubtitleEncoding(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const timing = lines[index].match(/([\d:]+[.,]\d+)\s*-->\s*([\d:]+[.,]\d+)/);
    if (!timing) continue;
    const content = lines.slice(index + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
    const start = seconds(timing[1]), end = seconds(timing[2]);
    if (!content || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (cues.at(-1)?.text === content && start <= cues.at(-1).end + 0.5) { cues.at(-1).end = end; continue; }
    cues.push({ start, end, text: content });
  }
  return cues.sort((a, b) => a.start - b.start);
}

const themes = [
  { name: '剥削策略与对手调整', words: ['剥削', '调整', '对手', 'exploit', 'opponent'] },
  { name: '翻前策略与位置', words: ['翻前', '位置', '加注', 'preflop', 'position'] },
  { name: '下注与价值提取', words: ['下注', '价值', '底池', 'bet', 'value', 'pot'] },
  { name: '范围与决策', words: ['范围', '决策', '策略', 'range', 'decision', 'strategy'] },
  { name: '学习方法与课程结构', words: ['学习', '课程', '训练', 'course', 'learn', 'study'] },
];
function topic(text) {
  const ranked = themes.map(item => ({ ...item, score: item.words.reduce((sum, word) => sum + (text.toLowerCase().match(new RegExp(word, 'g'))?.length ?? 0), 0) })).sort((a, b) => b.score - a.score);
  return ranked[0].score ? ranked[0].name : '讲解内容';
}
function candidates(cues) {
  const sentences = [];
  let buffer = '', start = 0;
  for (const cue of cues) {
    for (const part of cue.text.match(/[^。！？.!?]+[。！？.!?]?/g) || []) {
      if (!buffer) start = cue.start;
      const separator = /[A-Za-z0-9]$/.test(buffer) && /^[A-Za-z0-9]/.test(part) ? ' ' : '';
      buffer += separator + part.trim();
      if (/[。！？.!?]$/.test(part) || buffer.length > 240) {
        sentences.push({ start, text: buffer }); buffer = '';
      }
    }
  }
  if (buffer) sentences.push({ start, text: buffer });
  return sentences
    .filter(item => item.text.length >= 15)
    .map(item => ({ ...item, score: Math.min(item.text.length, 100) / 35 + themes.flatMap(t => t.words).filter(word => item.text.toLowerCase().includes(word)).length * 3 + (/因为|如果|应该|关键|需要|不要|important|should|because/i.test(item.text) ? 3 : 0) - (/点击|订阅|优惠|折扣|subscribe|discount|sign up/i.test(item.text) ? 6 : 0) }));
}
function select(cues, count, start = -Infinity, end = Infinity) {
  const ranked = candidates(cues).filter(item => item.start >= start && item.start < end).sort((a, b) => b.score - a.score);
  const picked = [];
  for (const candidate of ranked) {
    if (picked.some(item => Math.abs(item.start - candidate.start) < 7 || item.text === candidate.text)) continue;
    picked.push(candidate);
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}
const excerpt = text => escape(text.length > 300 ? `${text.slice(0, 300)}…` : text);

export { recognizeFrames } from './ocr.mjs';

export async function writeNotes(directory, media, ocr, warnings) {
  const available = Object.keys(media.captions || {});
  const language = available.includes('zh') ? 'zh' : available.includes('en') ? 'en' : available[0];
  const cues = language ? parseVtt(await readFile(path.join(directory, media.captions[language]), 'utf8')) : [];
  // A partial preview must not be represented as a full lesson just because its subtitle file is longer.
  const usableCues = media.fullPlayback ? cues : cues.filter(cue => cue.start < media.coveredSeconds).map(cue => ({ ...cue, end: Math.min(cue.end, media.coveredSeconds) }));
  if (!usableCues.length) warnings.push('未获取到有效字幕或语音转写，本次笔记仅包含截图与 OCR，缺少语音讲解。');
  if (language && language !== 'zh') warnings.push('本地模式保留原语言字幕，尚未接入自动翻译。');
  const lines = [
    `# ${escape(media.title)}`, '', '## 来源与处理信息', '',
    `- 视频链接：${media.url}`, `- 视频时长：${stamp(media.duration)}`,
    `- 实际覆盖：约 ${Math.round(media.coveredSeconds)} 秒${media.fullPlayback ? media.validationMethod === 'download-duration' ? '（完整提取已验证）' : '（完整播放已验证）' : '（部分内容）'}`,
    `- 生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）`,
    '- 整理方式：本地字幕提取式整理 + 本地 OCR，未调用大模型。要点为原文摘录，画面文字不等同于已理解牌局。',
    `- 字幕来源：${language ? media.captionSources?.[language]?.kind === 'asr' ? `${media.captionSources[language].provider} 语音识别，${language}，共 ${usableCues.length} 个音频分段；时间戳为分段定位` : `站点 ${language} 字幕，共 ${usableCues.length} 条` : '未获取'}`, '',
  ];
  if (warnings.length) lines.push('## 内容完整性与待核实项', '', ...[...new Set(warnings)].map(w => `- ${escape(w)}`), '');
  lines.push('## 内容概览', '');
  const topicNames = themes.filter(item => item.words.some(word => usableCues.some(cue => cue.text.toLowerCase().includes(word)))).map(item => item.name);
  lines.push(topicNames.length ? `字幕涉及：${topicNames.join('、')}。以下按时间整理原文要点，供回看复习。` : '以下根据可获取的字幕与关键画面整理。', '');
  lines.push('## 核心要点（原文摘录）', '');
  const highlights = select(usableCues, 8);
  lines.push(...(highlights.length ? highlights.map(item => `- **${stamp(item.start)}** ${excerpt(item.text)}`) : ['未提取到足够的字幕内容，请参考关键画面。']), '');
  lines.push('## 分章节学习笔记', '');
  const lastEnd = usableCues.at(-1)?.end ?? 0;
  const interval = Math.max(45, Math.ceil(lastEnd / 12 / 15) * 15);
  for (let start = 0; start < lastEnd; start += interval) {
    const section = usableCues.filter(cue => cue.start >= start && cue.start < start + interval);
    if (!section.length) continue;
    lines.push(`### ${stamp(start)} · ${topic(section.map(cue => cue.text).join(' '))}`, '');
    const points = select(usableCues, 3, start, start + interval);
    lines.push(...(points.length ? points.map(item => `- **${stamp(item.start)}** ${excerpt(item.text)}`) : section.slice(0, 2).map(item => `- **${stamp(item.start)}** ${excerpt(item.text)}`)), '');
  }
  lines.push('## 画面文字证据（本地 OCR，未经模型理解）', '');
  for (const frame of ocr) {
    lines.push(`### ${stamp(frame.time)} · 关键画面`, '', `[查看 ${stamp(frame.time)} 对应截图](${frame.file.replaceAll('\\', '/')})`, '');
    lines.push(frame.text ? `OCR 文字（置信度约 ${Math.round(frame.confidence)}%，请结合截图核对）：` : '该画面未识别到可靠文字。', '');
    if (frame.text) lines.push(...frame.text.split('\n').filter(Boolean).map(line => `> ${escape(line)}`), '');
  }
  if (!ocr.length) lines.push('本次未进行画面文字识别。', '');
  lines.push('## 复习清单', '', '- 对照时间戳回看核心要点，确认策略适用的前提。', '- 结合截图核对牌面、位置、筹码量和下注数字；OCR 结果不能直接作为准确牌局记录。', '- 用自己的话复述关键内容，将原文案例与个人推论分开记录。', '');
  const markdown = lines.join('\n');
  await writeFile(path.join(directory, '学习笔记.md'), markdown);
  await writeFile(path.join(directory, '视频信息整理.md'), markdown);
  const transcript = [`# ${escape(media.title)} · 完整转录`, '', `来源：${media.url}`, '', `转录方式：${media.captionSources?.[language]?.kind === 'asr' ? `${media.captionSources[language].provider} 语音识别；时间戳为音频分段定位，非逐句精确对齐` : '站点字幕'}`, '', `覆盖范围：${media.fullPlayback ? '完整提取时间范围' : `仅保留已验证的约 ${Math.round(media.coveredSeconds)} 秒`}`, '', ...usableCues.flatMap(cue => [`**${stamp(cue.start)} – ${stamp(cue.end)}**`, '', escape(cue.text), ''])].join('\n');
  await writeFile(path.join(directory, '完整转录.md'), transcript);
  return { cueCount: usableCues.length, language: language || null, noteMode: 'local-extractive', markdown };
}
