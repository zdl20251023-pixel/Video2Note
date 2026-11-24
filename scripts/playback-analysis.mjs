import { readFile } from 'node:fs/promises';

export async function wavDuration(file) {
  const buffer = await readFile(file);
  let byteRate;
  let dataBytes;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Expected RIFF WAV');
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const kind = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (kind === 'fmt ' && size >= 16) byteRate = buffer.readUInt32LE(offset + 16);
    if (kind === 'data') dataBytes = Math.min(size, buffer.length - offset - 8);
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes == null) throw new Error('WAV data or format missing');
  return dataBytes / byteRate;
}

export function analyzePlayback(summary, audioSeconds) {
  const observations = summary.observations;
  const jumps = [];
  for (let i = 1; i < observations.length; i++) {
    const previous = observations[i - 1];
    const current = observations[i];
    const advance = current.currentTime - previous.currentTime;
    const elapsed = current.elapsed - previous.elapsed;
    if (advance > elapsed + 2 || advance < -1) {
      jumps.push({ elapsed: current.elapsed, from: previous.currentTime, to: current.currentTime, advance });
    }
  }
  const last = observations.at(-1);
  const expectedAudio = summary.duration - (summary.recordingStart ?? 0);
  const full = last?.ended === true && jumps.length === 0
    && last.currentTime >= summary.duration - 1
    && audioSeconds >= expectedAudio - 2
    && last.elapsed >= expectedAudio - 2;
  return {
    status: full ? 'full-playback-verified' : 'incomplete-playback',
    recordedAudioSeconds: audioSeconds,
    playbackDiscontinuities: jumps,
    fullPlaybackCriteria: 'ended + continuous timeline + elapsed time and recorded audio cover expected duration',
  };
}
