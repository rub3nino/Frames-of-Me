#!/usr/bin/env node
/**
 * Generate favicon and app icons from the brand mark SVG.
 * Run: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
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

const svgPath = join(root, 'brand-identity/pecorella/logo/mark.svg');
const svgBuffer = readFileSync(svgPath);

console.log('Generating icons from', svgPath);

for (const { size, name, dest } of sizes) {
  const outPath = join(root, dest, name);
  await sharp(svgBuffer)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 243, g: 238, b: 230, alpha: 1 } // #f3eee6
    })
    .png()
    .toFile(outPath);
  console.log(`✓ Created ${name} (${size}x${size})`);
}

// Also create favicon.ico with multiple sizes
const icoPath = join(root, 'apps/web/public/favicon.ico');
await sharp(svgBuffer)
  .resize(32, 32, {
    fit: 'contain',
    background: { r: 243, g: 238, b: 230, alpha: 1 }
  })
  .png()
  .toFile(icoPath.replace('.ico', '-32.png'));

console.log('✓ Created favicon assets');
console.log('\nNext steps:');
console.log('1. Update apps/web/app/layout.tsx metadata if needed');
console.log('2. Verify icons appear correctly in browser tabs and when added to home screen');
