// Screenshot della SOLA landing a 390x844 e 1280x800 (adattato da shoot.mjs).
// Uso: node screenshots/shoot-landing.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const BASE = process.argv[2] ?? 'http://localhost:4300';
const viewports = [
  { w: 390, h: 844, tag: 'mobile' },
  { w: 360, h: 780, tag: 'mobile-sm' },
  { w: 1280, h: 800, tag: 'desktop' },
];

const browser = await chromium.launch();

// pagine del tema chiaro oltre alla landing
for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  for (const r of [{ path: '/accedi', name: 'accedi' }, { path: '/staff', name: 'staff' }]) {
    await page.goto(BASE + r.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) console.log(`OVERFLOW-X ${r.name} @${vp.tag}: +${overflow}px`);
    await page.screenshot({ path: join(outDir, `${r.name}-${vp.tag}.png`), fullPage: true });
    console.log(`ok ${r.name}-${vp.tag}.png`);
  }
  await page.close();
}

for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800); // font + entrata hero
  // scroll progressivo per attivare i reveal (IntersectionObserver), poi torna su
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.7;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 140));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800); // fine transizioni reveal
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) console.log(`OVERFLOW-X landing @${vp.tag}: +${overflow}px`);
  await page.screenshot({ path: join(outDir, `landing-${vp.tag}.png`), fullPage: true });
  console.log(`ok landing-${vp.tag}.png`);
  // dettaglio: details GDPR aperto (solo desktop)
  if (vp.tag === 'desktop') {
    await page.locator('.trust-more summary').click();
    await page.waitForTimeout(300);
    await page.locator('#privacy').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, 'landing-privacy-open.png') });
    console.log('ok landing-privacy-open.png');
  }
  await page.close();
}
await browser.close();
