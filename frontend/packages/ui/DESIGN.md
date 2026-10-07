# Frames of Me — Brand & Design System (v2, Apple-grade, light-only)

> This file is the **single reference for the whole visual identity**: color, space, type,
> photo treatment, motion (where and why), and the rules every page must obey. It replaces the
> v1 warm-editorial direction entirely. Tokens are the law: [`tokens.css`](tokens.css).
>
> Built following **only** the rules inside the `impeccable` skill (craft-floor, colorize,
> layout, animate, typeset, new-work) and grounded in the **real, verified Apple design system**
> (apple.com) plus the clean photo-gallery language of Pic-Time / Pixieset. The logo is generated
> with the `logo-generator` skill. Product truth lives in [`../PRODUCT.md`](../PRODUCT.md);
> flows in [`../../docs/ux-flows.md`](../../docs/ux-flows.md).

---

## 0. Why we rebuilt (and what impeccable told us)

The v1 look — warm cream ground, high-contrast serif display (Fraunces), terracotta accent — is
**the single most common AI-generated cluster**, named verbatim in impeccable's calibration note.
It also broke hard rules: an **eyebrow/kicker above every heading** (an absolute ban), same-size
icon+title+text cards as page structure, and an identical fade-in on every section. v2 fixes all
of it.

Direction is **brief-pinned** (impeccable: *"the brief wins — a user/brief-pinned direction beats
the roll"*): the user pinned **Apple-grade, serious, light, decisive**, referencing Apple's own
galleries and Pic-Time. So we execute that world at **full fidelity**, making those real products
the craft bar — not a softened version of them.

---

## 1. Essence

**Frames of Me makes finding yourself in thousands of photos feel instant and certain.**
The feeling to engineer: **precision + calm confidence**. Not cozy, not playful — *trustworthy
and exact*, the way Apple hardware feels. Photos are the subject; the interface is a quiet,
precise frame around them (impeccable **Experience** mode for the gallery, **Operate** for
upload/admin, **Persuade** for the landing).

Three words: **Precise · Quiet · Certain.**

---

## 2. Color — serious, clear, light only

Light is chosen from the **use scene** (impeccable forbids picking by category): a conference in
daylight, 6.000 phones held up in bright rooms, photographers on laptops, a print-studio sense of
clarity. **There is no dark theme.** Neutral grey is valid and load-bearing here (impeccable:
*"Neutral gray is valid when it serves the world"*) — Apple's whole system is precise neutrals
plus one blue.

Values are Apple's real tokens. All in [`tokens.css`](tokens.css).

### Neutrals (the system)
| Role | Token | Value |
| --- | --- | --- |
| Base canvas | `--c-canvas` | `#F5F5F7` (Apple soft grey) |
| Surface / cards | `--c-surface` | `#FFFFFF` |
| Sunken / wells | `--c-sunken` | `#ECECEE` |
| Ink (primary text) | `--c-ink` | `#1D1D1F` |
| Secondary text | `--c-ink-2` | `#6E6E73` |
| Tertiary / hint | `--c-ink-3` | `#86868B` |
| Hairline border | `--c-line` | `#D2D2D7` |
| Strong border | `--c-line-2` | `#C7C7CC` |

### Accent — one blue, precise
| Role | Token | Value |
| --- | --- | --- |
| Accent (actions, focus, selection) | `--c-accent` | `#0071E3` |
| Hover | `--c-accent-hover` | `#0077ED` |
| Pressed / link | `--c-accent-press` | `#0066CC` |
| Soft accent surface | `--c-accent-soft` | `#E8F1FD` |

One accent, used with **rarity** (impeccable: rarity gives an accent force). The blue marks the
**one** primary action per view and nothing decorative. Everything else is ink-on-white.

### Semantic (muted, serious — not candy)
`--c-success #248A3D`, `--c-warning #B25E00`, `--c-danger #D70015`, `--c-info = accent`. Each has a
soft surface. Status is always **icon + label + color**, never color alone.

### Color rules (from impeccable colorize + craft-floor)
- Never pure black text (`#1D1D1F`, not `#000`). White surfaces are `#FFFFFF`; the *ground* is `#F5F5F7`.
- On any colored surface, derive secondary text from that hue — **never flat grey on color**.
- **No gradient text. No decorative gradients. No colored glows.** Emphasis = weight or size.
- The accent owns a role (action/focus/selection), not scattered confetti.
- Contrast: body ≥ 4.5:1, large ≥ 3:1, controls/icons/focus ≥ 3:1. Verified on real pairs.

---

## 3. Space & shape — decisive, Apple rhythm

- **Spacing scale (Apple's):** 4 · 8 · 12 · 16 · 24 · 40 · 64 · 80 (+ 2/32/56/96/128 as useful
  middles). Tokens `--s-*`. Rhythm rule (craft-floor): tight within a group, generous between
  groups, and **more space above a heading than below it**.
- **Radius (Apple's):** 8 (sm) · 12 (md) · 18 (lg) · pill. Buttons 12, cards/photos 12–18, pills
  full. Decisive, never bubbly.
- **Lines:** 1px hairlines in `--c-line`. Decisive and crisp — a hairline is a real edge, not a
  suggestion. **No colored `border-left/right` above 1px** (impeccable default-refuse).
- **Depth:** shadows always carry **offset + soft blur** (craft-floor); never a zero-offset
  colored halo. Apple separates mostly with the `#F5F5F7` ground + hairlines and uses shadow
  sparingly, only for genuinely floating things (menus, sheets, the hovered photo).
- **No nested cards. Cards are the lazy container** — prefer whitespace + hairlines to boxes.

---

## 4. Typography — one precise family

Apple ships SF Pro; SF Pro is not web-licensable, and a system face may not be the display voice
(craft-floor). We self-host the closest SF-grade grotesque that is **not** an AI default:
**Geist** (Vercel, OFL). It is neutral, exact, and modern — SF's register without being SF.

- **Geist Sans** — everything: display, headings, UI, body. Weights 400 / 500 / 600 (700 rare).
- **Geist Mono** — only for data, counts, codes, measurements (upload metrics, IDs). Never as a
  "technical" costume (craft-floor).
- **One family.** A second family would need a role it alone can perform; none exists here
  (typeset). The hierarchy comes from **size + weight + space**, Apple-style, not from mixing faces.

Discipline (craft-floor + typeset):
- Body `1rem` (16px) floor, measure **65–75ch**. Display max **6rem**.
- **Tracking tightens as size grows** — display `-0.025em` to `-0.04em` (floor `-0.04em`);
  body `0`. Large SF-style text reads too loose without negative tracking.
- Line-height: tight on display (`1.05–1.1`), comfortable on body (`1.47`, Apple's body leading).
- Headings `text-wrap: balance`; body `pretty`. Obvious, deliberate scale and weight steps.
- Tabular numerals (`font-feature-settings: "tnum"`) on all data/counts.

Google Fonts link (prototypes):
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

**No eyebrows / kickers above headings — ever** (absolute ban). The heading carries its own weight.

---

## 5. Photos — the subject, framed precisely

Photos are the product. Treat them like Apple/Pic-Time galleries:
- **Large, clean, photo-first.** Let imagery lead from the first viewport; the UI recedes.
- Aligned **grids** for scanning (gallery, admin moderation), generous consistent `gap`.
- Rounded corners **12–18px**, no heavy frames. Shadow only when a photo truly floats (hover, the
  selected/zoomed photo) — offset + soft blur, never a glow.
- Full-bleed or near-full-bleed hero imagery on the landing; whitespace (`#F5F5F7`/`#FFF`) does the
  framing, not borders.
- Never crop a face out of a thumbnail's safe center. Placeholder tiles use `--c-sunken`, plain.
- **No geometric/organic masks faking a cutout** (craft-floor): a photo is a rectangle with a
  radius, or a real cut-out asset — never a `clip-path` approximation.

---

## 6. Motion — one authored moment, then quiet feedback

impeccable: **one authored moment, not scattered reveals**, and never the same fade-in on every
section. Material beyond transform/opacity is allowed when smooth (clip-path, mask, blur, shadow).

- **The authored moment = "Recognition."** The product's whole promise is *we find you*. The
  landing's single focal sequence stages exactly that: a search frame settles over a wall of
  photos and the matching ones resolve into focus / lift into a clean grid — a precise,
  mechanical "lock-on," once, on load. It is specific to this product; a generic hero fade is not
  allowed to stand in for it.
- **Gallery reveal:** when results are ready, photos resolve in a tight, capped stagger (a *list
  appearing as a list*), not a per-scroll reveal on every element.
- **Everything else is feedback, not spectacle:** press/hover state changes, the selection tick,
  the sheet/menu spring. Fast and quiet.
- **Easing & timing** (animate): natural deceleration `cubic-bezier(0.16, 1, 0.3, 1)` for
  arrivals; **no bounce/elastic by reflex**. Durations: 100–150ms feedback · 150–300ms routine ·
  300–500ms overlay/layout · 500–800ms the one authored entrance. **Exit faster than entrance.**
- Animate compositor-safe props; bound expensive effects; **content visible by default** (no
  element hidden only by animation). Every motion has a `prefers-reduced-motion` path that keeps
  meaningful state/opacity changes and drops spatial movement.

---

## 7. Browser surfaces — the cheapest craft signal

craft-floor calls these the tell that a page was *built*, not assembled. Theme them from the
palette on every page:
- **Text selection** → accent-soft background, ink text.
- **Caret** → accent (`caret-color`).
- **Custom scrollbars** → neutral track/thumb from the palette.
- **Focus ring** → a 3px accent ring (`--ring-focus`), visible on every interactive element.
- **Underline offset** on links, **tabular numerals** on data.

---

## 8. Components — Apple precision

- **Buttons:** pill or 12px-radius. Primary = solid accent, white text. Secondary = white surface,
  hairline border, ink text. Tertiary = text-only accent. Press = quick scale-down (feedback on
  pointer-down). No gradients, no glow.
- **Inputs:** white, hairline border, 12px radius; focus = accent border + ring. Clear labels.
- **Consent (GDPR):** explicit, never pre-checked, large hit target — the trust moment, designed calmly.
- **Cards:** used sparingly, white on `#F5F5F7`, hairline + very soft shadow; **never nested**.
- **Chips / segmented:** Apple-style neutral; selected = white on sunken track, or ink fill.
- **Status badges:** icon + label + semantic color; muted, not candy.
- **Chrome:** top bar is a thin, mostly-opaque white/`#F5F5F7` strip with a hairline, content
  scrolls under it quietly (translucency only as a real effect, not decoration).

States required on everything: hover, active, disabled, loading, error, empty, keyboard-focus.

---

## 9. Per-surface intent

- **Landing (Persuade):** photo-led hero + the Recognition authored moment; one blue CTA; prove
  the mechanism in the first viewport (show the search→match happening), not a claim. No eyebrow,
  no feature-card trio as the page's spine.
- **Gallery (Experience):** the artifact leads. A big, quiet, aligned photo grid; chrome recedes;
  selection + download are precise and obvious. This is the Apple/Pic-Time heart of the product.
- **Upload (Operate):** a calm precise workspace; dense but scannable; mono metrics; done/failed
  unmistakable; drag-drop is the hero.
- **Admin (Operate):** sidebar + content, precise tables and stat rows; destructive actions always
  behind an explicit confirm; show who did what.

---

## 10. Do / Don't

**Do:** light only; one blue accent used rarely; neutral greys; decisive hairlines; Geist; big
clean photos; one authored "Recognition" moment; theme browser surfaces; generous Apple spacing;
`cubic-bezier(0.16,1,0.3,1)`; confirm destructive actions.

**Don't:** dark mode; eyebrows/kickers (**banned**); warm-cream+serif+terracotta; Fraunces/Inter/
the AI-default faces; gradient text or decorative gradients; colored glows / zero-offset shadows;
nested cards; icon+title+text card trios as page structure; the same fade on every section;
bounce/elastic easing; emoji/Unicode as icons; mono as a "technical" costume; geometric masks
faking photo cut-outs.
