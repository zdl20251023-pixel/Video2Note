export function chunkCues(cues, limit) {
  const chunks = [];
  let current = [], length = 0;
  for (const cue of cues) {
    const line = `[${cue.start.toFixed(2)}] ${cue.text}\n`;
    if (line.length > limit) throw new Error('单条字幕过长，超出模型输入限制');
    if (current.length && length + line.length > limit) { chunks.push(current); current = []; length = 0; }
    current.push(cue); length += line.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
export function validateSummary(raw, maxTime) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(cleaned); } catch { throw new Error('模型总结不是有效 JSON，已保留本地整理'); }
  const string = (value, limit = 1400) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('模型总结缺少有效文本');
    if (value.length > limit) throw new Error('模型总结字段过长');
    return value.trim();
  };
  const items = (value, count) => {
    if (!Array.isArray(value) || value.length > count) throw new Error('模型总结结构不完整');
    return value.map(item => {
      if (typeof item.timeSeconds !== 'number' || !Number.isFinite(item.timeSeconds) || item.timeSeconds < 0 || item.timeSeconds > maxTime + 0.5) throw new Error('模型引用的时间戳超出已获取内容范围');
      return { title: string(item.title, 100), detail: string(item.detail), timeSeconds: item.timeSeconds };
    });
  };
  const overview = string(data.overview, 1800);
  const keyPoints = items(data.keyPoints, 12), chapters = items(data.chapters, 16), cases = items(data.cases, 8);
  if (!keyPoints.length) throw new Error('模型未提取有效核心要点');
  if (!Array.isArray(data.review) || data.review.length > 12) throw new Error('模型缺少复习清单');
  return { overview, keyPoints, chapters, cases, review: data.review.map(item => string(item, 500)) };
}
export { generateTeaching as writeSemanticNotes } from './teaching.mjs';
