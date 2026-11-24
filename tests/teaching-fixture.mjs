export const course = { title: '河牌加注教学', overview: '根据对手失误调整策略，先确认适用条件。', objectives: ['理解河牌决策'], prerequisites: ['了解位置与底池'], review: ['何时应该加注？'], uncertainties: ['未展示手牌需核对'] };
export const state = { positions: 'BTN 对 BB', holeCards: 'AhKd', board: 'As7h2c4s9d', pot: '5.5 BB', stacks: '97.5 BB', actions: 'BB check', overlays: '河牌决策' };
export function teachingReply(messages) {
  if (messages[0].content?.includes('[VIDEO2NOTE_REFINEMENT]')) return { markdown: '## 教学核心\n\n王烨在 HJ 开池，谭轩在 CO 持 KK 加注。翻牌 5♥ 5♦ 6♥，转牌 A♦，河牌 10♥。重点是按对手范围判断下注和弃牌，不能忽略底池与有效筹码缺失。\n\n### 教学旁白\n\n先确认位置和牌面，再依次演示翻前、翻牌、转牌和河牌动作，说明每一步决策的前提。' };
  const content = messages[1].content;
  if (typeof content === 'string') {
    if (!content.startsWith('讲稿依据：')) return course;
    const input = JSON.parse(content.slice('讲稿依据：'.length));
    const time = input.evidenceFrames[0]?.time ?? input.cueRange[0]?.start ?? 0;
    return { segments: [{ title: '河牌决策', timeSeconds: time, sourceType: '教学改编', objective: '理解适用条件', prerequisites: '了解位置与底池', initialState: '王烨 HJ 开池 1.5万，谭轩 CO 持 KK 加注到 7万，王烨跟注', actions: '按翻前、翻牌、转牌、河牌展示下注与弃牌', narration: '先确认王烨与谭轩的位置。转牌以半池下注，河牌在三红桃面弃掉 KK，王烨展示 7♦9♦。这些是画面提供的背景。', annotations: '标注各街牌面和下注金额', question: '河牌弃牌的前提是什么？', uncertainties: ['未展示底池需核对'], evidenceFiles: input.evidenceFrames.map(frame => frame.file) }] };
  }
  const raw = content.find(part => part.type === 'text').text.split('本批次证据：')[1];
  const batch = JSON.parse(raw);
  const times = [...batch.cues.map(cue => cue.start), ...batch.frames.map(frame => frame.time)];
  return { background: '河牌教学场景，位置 BTN 与 BB。', narration: '讲解根据对手失误调整策略。', strategy: '原作者观点需结合对手范围核对。', uncertainties: ['未展示的信息不补造'], frames: batch.frames.map(frame => ({ file: frame.file, description: '牌局总览，展示翻前至河牌的完整行动', background: '王烨在 HJ，谭轩在 CO 持 KK，视频回顾两人的牌局。', visualFacts: ['王烨 HJ 开池 1.5万，谭轩 CO 持 KK 3bet 到 7万，王烨 call', '河牌王烨展示 7♦9♦'], streetTimeline: [
    { street: '翻前', players: '王烨 HJ、谭轩 CO', board: '未展示', actions: 'HJ open；CO 3bet；HJ call', amounts: 'open 1.5万，3bet 到 7万', commentary: '未提供', sourceType: '画面可见事实' },
    { street: '翻牌', players: '王烨、谭轩', board: '5♥ 5♦ 6♥', actions: '王烨 check；谭轩 c-bet；王烨 call', amounts: 'c-bet 8万', commentary: '公对加听花面', sourceType: '原作者观点' },
    { street: '转牌', players: '谭轩持 KK', board: '5♥ 5♦ 6♥ A♦', actions: 'KK 下注半池', amounts: '半池，具体金额未知', commentary: '拒绝权益，便宜摊牌', sourceType: '原作者观点' },
    { street: '河牌', players: '谭轩、王烨', board: '5♥ 5♦ 6♥ A♦ 10♥', actions: '谭轩弃掉 KK，王烨 show 7♦9♦', amounts: '未展示', commentary: '视频认为弃牌谨慎，对手诈唬普遍不足', sourceType: '原作者观点' }
  ], teachingMeaning: '用完整逐街背景解释河牌决策，不只摘录语音。', uncertainties: ['未展示底池不补造'], reason: '保留筹码与牌面证据', duplicateOf: null, state })), segments: [{ title: '河牌决策', timeSeconds: Math.min(...times, batch.maxTime), sourceType: '教学改编', objective: '理解适用条件', prerequisites: '了解位置与底池', initialState: 'BTN 对 BB，其余信息待核对', actions: '显示底池，依次展示过牌和决策提示', narration: '先判断对手范围，再考虑加注。', annotations: '标注位置和底池', question: '加注需要哪些前提？', uncertainties: ['金额待核对'], evidenceFiles: batch.frames.map(frame => frame.file) }] };
}
