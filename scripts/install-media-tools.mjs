import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function installMediaTool() {
  if (process.platform !== 'win32') throw new Error('本安装脚本针对 Windows；其他系统请安装 yt-dlp 并设置 YT_DLP_PATH');
  const directory = path.join(root, '.local/tools');
  await mkdir(directory, { recursive: true });
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  const checksums = await fetch(`${base}SHA2-256SUMS`, { signal: AbortSignal.timeout(60000) });
  if (!checksums.ok) throw new Error('无法获取官方校验清单，请检查 GitHub 网络连接');
  const expected = (await checksums.text()).split('\n').find(line => /\s\*?yt-dlp\.exe\s*$/.test(line))?.split(/\s+/)[0];
  if (!/^[a-f\d]{64}$/i.test(expected || '')) throw new Error('官方校验清单缺少 yt-dlp.exe');
  const response = await fetch(`${base}yt-dlp.exe`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('视频提取工具下载失败');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 150 * 1024 * 1024 || createHash('sha256').update(buffer).digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error('视频提取工具校验失败，未安装');
  const temp = path.join(directory, 'yt-dlp.exe.download');
  await writeFile(temp, buffer);
  await rename(temp, path.join(directory, 'yt-dlp.exe'));
  await writeFile(path.join(directory, 'yt-dlp-install.json'), JSON.stringify({ installedAt: new Date().toISOString(), sha256: expected, source: base }, null, 2));
  return { message: '视频提取工具已安装并通过官方 SHA256 校验' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log((await installMediaTool()).message); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
