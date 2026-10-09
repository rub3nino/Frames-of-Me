// Screenshot di tutte le rotte a 390x844 e 1280x800.
// Uso: node screenshots/shoot.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const BASE = 'http://localhost:4300';
const routes = [
  { path: '/', name: 'landing' },
  { path: '/accedi', name: 'accedi' },
  { path: '/staff', name: 'staff' },
  { path: '/app', name: 'app' },
  { path: '/admin', name: 'admin' },
];
const viewports = [
  { w: 390, h: 844, tag: 'mobile' },
  { w: 1280, h: 800, tag: 'desktop' },
];

const browser = await chromium.launch();
for (const vp of viewports) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  for (const r of routes) {
    await page.goto(BASE + r.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600); // font
    // scroll progressivo per attivare i reveal (IntersectionObserver), poi torna su
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.7;
      for (let y = 0; y <= document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(700); // fine transizioni reveal
    // overflow orizzontale?
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) console.log(`OVERFLOW-X ${r.name} @${vp.tag}: +${overflow}px`);
    await page.screenshot({ path: join(outDir, `${r.name}-${vp.tag}.png`), fullPage: true });
    console.log(`ok ${r.name}-${vp.tag}.png`);

    if (r.path === '/app') {
      await page.getByRole('tab', { name: 'Postcards' }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(outDir, `app-postcards-${vp.tag}.png`), fullPage: true });
      console.log(`ok app-postcards-${vp.tag}.png`);
    }
  }
  await page.close();
}
await browser.close();
