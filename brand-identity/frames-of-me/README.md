# Frames of Me Brand Mark

## Icon Source

`icon-source.png` — The abstract frame brand mark for favicons and app icons.

- **Size:** 1024×1024 pixels
- **Design:** White rounded square frame with layered grey shadows and a white circle in the center
- **Background:** Black (preserved for favicons)
- **Usage:** Safari tab icons, apple-touch-icon, PWA icons

## Regenerating Icons

After updating `icon-source.png`, regenerate all favicon/app icons:

```bash
node scripts/generate-icons.mjs
```

This creates:
- `favicon-16x16.png`, `favicon-32x32.png`
- `apple-touch-icon.png` (180×180)
- `icon-192.png`, `icon-512.png` (PWA)
- `favicon.ico`
- `apps/web/app/icon.png` (Next.js fallback)
