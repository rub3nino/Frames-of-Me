#!/usr/bin/env node
/**
 * Generate favicon and app icons from the Frames of Me brand mark PNG.
 * Source: brand-identity/frames-of-me/icon-source.png (1024×1024 black bg, white frame mark)
 * Run: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const sizes = [
  { size: 16, name: 'favicon-16x16.png', dest: 'apps/web/public' },
  { size: 32, name: 'favicon-32x32.png', dest: 'apps/web/public' },
  { size: 180, name: 'apple-touch-icon.png', dest: 'apps/web/public' },
  { size: 192, name: 'icon-192.png', dest: 'apps/web/public' },
  { size: 512, name: 'icon-512.png', dest: 'apps/web/public' },
];

const sourcePath = join(root, 'brand-identity/frames-of-me/icon-source.png');

console.log('Generating icons from', sourcePath);
console.log('Source: Frames of Me abstract frame mark (1024×1024 PNG)\n');

for (const { size, name, dest } of sizes) {
  const outPath = join(root, dest, name);
  await sharp(sourcePath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 1 } // Black background (brand mark has black bg)
    })
    .png()
    .toFile(outPath);
  console.log(`✓ Created ${name} (${size}×${size})`);
}

// favicon.ico (use 32×32 PNG)
const icoPath = join(root, 'apps/web/public/favicon.ico');
await sharp(sourcePath)
  .resize(32, 32, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 1 }
  })
  .png()
  .toFile(icoPath);

console.log('✓ Created favicon.ico (32×32)');

// Also create icon.svg placeholder (Next.js App Router convention)
// Since source is PNG, just copy a sized version as reference
const iconSvgNote = join(root, 'apps/web/app/icon.png');
await sharp(sourcePath)
  .resize(192, 192, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 1 }
  })
  .png()
  .toFile(iconSvgNote);
console.log('✓ Created app/icon.png (192×192) — Next.js will use this as favicon fallback');

console.log('\n✅ All icons generated from Frames of Me brand mark');
console.log('   Browser tabs, Safari, iOS, and Android will show the white frame on black.');
console.log('\nTo regenerate: node scripts/generate-icons.mjs');
