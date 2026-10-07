# RePhoto — UI & Brand (`design/`)

Static HTML/CSS/JS prototype of the whole product UI, built on a single brand system.
This is the **design/brand layer** — the visual source of truth that precedes wiring the real
Next.js app in `apps/web`. Aesthetic (v2): **Apple-grade — serious, clear, light-only**,
grounded in Apple's real design-system values and the clean photo galleries of Pic-Time, with
every rule taken from the `impeccable` skill (one blue accent used rarely, decisive hairlines,
one authored "Recognition" motion moment, no eyebrows, no dark theme). Type is **Geist**.

## How to view
Open any page directly, or serve the folder:

```bash
cd design && python3 -m http.server 4599
```

Then visit `http://localhost:4599/pages/index.html`.

## Folder map
```
design/
├─ README.md              ← this file
├─ PRODUCT.md             ← product context (audience, voice, constraints) — impeccable style
├─ styleguide.html        ← living brand board (open this to see the whole system)
├─ brand/
│  ├─ DESIGN.md           ← full brand identity (logo, color, type, motion, do/don't)
│  ├─ tokens.css          ← ★ single source of truth: color/type/space/radius/shadow/motion (+ dark)
│  ├─ base.css            ← reset + element defaults + layout helpers
│  ├─ components.css      ← the component kit (buttons, fields, cards, tints, tiles, nav, …)
│  ├─ motion.js           ← Apple-style motion engine (press, reveal, fan, count-up, sheets, theme)
│  ├─ logo.svg / mark.svg ← brand marks (Focus Lock)
│  ├─ logo-explorations.html ← 6 logo directions to choose from
├─ assets/
│  └─ ph-01…12.svg        ← on-brand placeholder "photos" (replace with real event photos)
├─ pages/
│  ├─ index.html          ← LANDING (shared entry; editorial photo-fan hero)
│  ├─ participant/        ← mobile-first guest flow
│  │  ├─ iscrizione.html · attesa.html · verify.html · selfie.html · galleria.html · i-miei-dati.html
│  ├─ photographer/       ← desktop-first
│  │  ├─ invito.html · upload.html
│  └─ admin/              ← desktop
│     ├─ login.html · dashboard.html · eventi.html · fotografi.html · partecipanti.html · foto.html · retention.html · audit.html
└─ emails/                ← transactional HTML emails (table-based, inline styles)
   ├─ magic-link.html · invito.html · foto-pronte.html · nuove-foto.html
```

## The one rule
**Everything is token-driven.** Components never hardcode a color/space/radius that exists in
`tokens.css`. Use `var(--token)`. Dark mode and theming come for free when you only use tokens.

## Where the flows come from
Page-by-page flows, states, GDPR checkpoints and open API gaps live in
[`../docs/ux-flows.md`](../docs/ux-flows.md). This folder is the visual realization of that study.

## Fonts
Loaded from Google Fonts in each page `<head>`: **Geist** (one family — display, UI, body) and
**Geist Mono** (data, counts, codes). SF-grade precision, self-hostable, and deliberately not
Inter/Fraunces (both are AI-default faces `impeccable` flags).

## Next step (after design sign-off)
Port these components into `apps/web` as React components (the token CSS can be reused almost
verbatim as a global stylesheet / CSS variables layer).
