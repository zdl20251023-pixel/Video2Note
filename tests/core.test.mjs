import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt } from '../server/notes.mjs';
import { normalizeUrl, safeOutputPath } from '../server/store.mjs';
import { analyzePlayback } from '../scripts/playback-analysis.mjs';
import { normalizeSubtitleEncoding } from '../server/captions.mjs';

test('rejects other sites, credentials, local URLs and non-video routes', () => {
  for (const url of ['http://127.0.0.1/', 'https://pokercoaching.com.evil.test/courses/a/b/', 'https://user:pass@pokercoaching.com/courses/a/b/', 'https://pokercoaching.com/courses/a/']) {
    assert.throws(() => normalizeUrl(url));
  }
  assert.equal(normalizeUrl('https://pokercoaching.com/courses/a/b?token=discard'), 'https://pokercoaching.com/courses/a/b/');
});
test('output lookup cannot escape a task directory', () => {
  const id = 'f770b993-daa0-45a7-9ad6-77ca62766b38';
  for (const value of ['../auth.json', '..\\auth.json', 'images/../../auth.json', 'C:/Windows/win.ini']) assert.throws(() => safeOutputPath(id, value));
});
test('parses VTT cue settings, multiline text and duplicate rolling captions', () => {
  const cues = parseVtt('WEBVTT\n\n1\n00:00.500 --> 00:02.000 align:start\n<v speaker>下注 &amp; 范围</v>\n第二行\n\n2\n00:01.500 --> 00:03.000\n下注 &amp; 范围 第二行\n\n3\n00:03.000 --> 00:04.000\n另一个要点');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0.5);
  assert.equal(cues[0].end, 3);
  assert.equal(cues[0].text, '下注 & 范围 第二行');
});
test('an ended preview that jumps to the end is not a fully watched video', () => {
  const result = analyzePlayback({ duration: 104.43, recordingStart: 0, observations: [{ elapsed: 58, currentTime: 58 }, { elapsed: 60, currentTime: 104.43, ended: true }] }, 60.12);
  assert.equal(result.status, 'incomplete-playback');
  assert.equal(result.playbackDiscontinuities.length, 1);
});
test('full continuous playback requires both wall time and recorded audio coverage', () => {
  const data = { duration: 10, recordingStart: 0, observations: [{ elapsed: 0, currentTime: 0 }, { elapsed: 5, currentTime: 5 }, { elapsed: 10, currentTime: 10, ended: true }] };
  assert.equal(analyzePlayback(data, 10).status, 'full-playback-verified');
  assert.equal(analyzePlayback(data, 5).status, 'incomplete-playback');
});
test('repairs the site Chinese caption mojibake without changing correct text or English', () => {
  assert.equal(normalizeSubtitleEncoding('æˆ‘æ˜¯ Jonathan Littleï¼Œ'), '我是 Jonathan Little，');
  assert.equal(normalizeSubtitleEncoding('这是正确的中文字幕。'), '这是正确的中文字幕。');
  assert.equal(normalizeSubtitleEncoding('A café in position.'), 'A café in position.');
  assert.equal(normalizeSubtitleEncoding('1-3ã€\u00812-5'), '1-3、2-5');
});
