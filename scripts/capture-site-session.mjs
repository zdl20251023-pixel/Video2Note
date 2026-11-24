import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { isPlatformDomain, platformInfo, cookiesToNetscape } from '../server/platforms.mjs';
const platformId = process.argv[2] || 'pokercoaching';
platformInfo(platformId);

// Attach only after the user has finished interactive sign-in.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context available');
  const pages = context.pages().filter(p => {
    try { return isPlatformDomain(new URL(p.url()).hostname, platformId); } catch { return false; }
  });
  if (!pages.length) throw new Error('Open the selected platform in the login browser first');
  // Only export this project's target site state. Never persist Google account cookies.
  const state = await context.storageState();
  const siteDomain = domain => isPlatformDomain(domain, platformId);
  const filtered = {
    cookies: state.cookies.filter(cookie => siteDomain(cookie.domain)),
    origins: state.origins.filter(origin => siteDomain(new URL(origin.origin).hostname)),
  };
  if (!filtered.cookies.length) throw new Error('No target platform cookies found; finish sign-in first');
  await mkdir('.local', { recursive: true });
  await mkdir('.local/platform-cookies', { recursive: true });
  await mkdir('.local/platform-sessions', { recursive: true });
  await writeFile(platformId === 'pokercoaching' ? '.local/auth.json' : `.local/platform-sessions/${platformId}.json`, JSON.stringify(filtered, null, 2), { mode: 0o600 });
  await writeFile(`.local/platform-cookies/${platformId}.txt`, cookiesToNetscape(filtered.cookies), { mode: 0o600 });
  console.log(`Saved ${platformId}-only session (${filtered.cookies.length} cookies); no cookie values logged.`);
} finally {
  // Disconnect Playwright; leave the user-operated browser open.
  await browser.close();
}
