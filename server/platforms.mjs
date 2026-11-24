export const PLATFORMS = [
  { id: 'pokercoaching', label: 'PokerCoaching', loginUrl: 'https://pokercoaching.com/', domains: ['pokercoaching.com'], example: 'https://pokercoaching.com/courses/complete-cash-game-system/welcome-to-the-complete-cash-game-system/' },
  { id: 'youtube', label: 'YouTube', loginUrl: 'https://www.youtube.com/', domains: ['youtube.com'], example: 'https://www.youtube.com/watch?v=my5bEyyzD58' },
  { id: 'bilibili', label: 'B站', loginUrl: 'https://www.bilibili.com/', domains: ['bilibili.com'], example: 'https://www.bilibili.com/video/BV1b34y1B7Ns/' },
];
export function parseVideoUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的视频地址'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('视频地址必须使用 HTTPS，且不能包含账号密码或自定义端口');
  const host = url.hostname.toLowerCase();
  if (host === 'pokercoaching.com' && /^\/courses\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return { platform: 'pokercoaching', url: `https://pokercoaching.com${url.pathname.replace(/\/$/, '')}/` };
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) {
    let id;
    if (host.endsWith('youtu.be')) id = url.pathname.slice(1).replace(/\/$/, '');
    else if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/)?.[1];
    if (id && /^[\w-]{11}$/.test(id)) return { platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
    throw new Error('请提供 YouTube 单个视频链接，暂不支持频道和播放列表');
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host)) {
    const id = url.pathname.match(/^\/video\/(BV[\dA-Za-z]{10}|av[1-9]\d*)\/?$/)?.[1];
    if (!id) throw new Error('请提供 B站 /video/BV... 或 /video/av... 的单个视频链接');
    const part = url.searchParams.get('p');
    if (part && (!/^[1-9]\d{0,3}$/.test(part))) throw new Error('B站分P编号无效');
    return { platform: 'bilibili', url: `https://www.bilibili.com/video/${id}/${part && part !== '1' ? `?p=${part}` : ''}` };
  }
  throw new Error('暂支持 PokerCoaching、YouTube 和 B站的单个视频页面');
}
export const platformInfo = id => {
  const platform = PLATFORMS.find(item => item.id === id);
  if (!platform) throw new Error('平台不受支持');
  return platform;
};
export function isPlatformDomain(domain, platformId) {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  return platformInfo(platformId).domains.some(root => normalized === root || normalized.endsWith(`.${root}`));
}
export function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Project-only platform session. Do not share.'];
  for (const cookie of cookies) {
    if ([cookie.domain, cookie.path, cookie.name, cookie.value].some(value => /[\r\n\t]/.test(value))) continue;
    lines.push([`${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.floor(cookie.expires || 0)), cookie.name, cookie.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}
