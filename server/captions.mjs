// Some site VTTs contain UTF-8 text already misdecoded as Windows-1252.
// Repair only when round-tripping yields valid UTF-8 with more Chinese text.
const reverse1252 = new Map(Array.from({ length: 256 }, (_, byte) => [String.fromCharCode(byte), byte]));
// Explicitly map the CP1252 extension block; small-ICU Node builds may treat it as Latin-1.
[...'€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'].forEach((character, index) => reverse1252.set(character, 0x80 + index));
export function normalizeSubtitleEncoding(text) {
  return text.replace(/^\uFEFF/, '').split('\n').map(line => {
    let current = line;
    for (let attempt = 0; attempt < 2; attempt++) {
      const bytes = [];
      for (const character of current) {
        const byte = reverse1252.get(character);
        if (byte === undefined) return current;
        bytes.push(byte);
      }
      let candidate;
      try { candidate = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
      catch { return current; }
      const han = value => (value.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/g) || []).length;
      if (han(candidate) <= han(current)) return current;
      current = candidate;
    }
    return current;
  }).join('\n');
}
