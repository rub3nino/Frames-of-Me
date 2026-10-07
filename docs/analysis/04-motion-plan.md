# RePhoto — Motion plan

How the whole product moves. Combines two rulebooks: **impeccable** (one authored moment, not
scattered effects) and **Emil Kowalski** (the decision framework, strong curves, physicality,
performance). Values live in [`../../design/brand/tokens.css`](../../design/brand/tokens.css);
behavior in [`../../design/brand/motion.js`](../../design/brand/motion.js).

---

## 1. Philosophy (the two rules that never conflict)

- **impeccable:** a surface earns **one** authored moment; everything else is quiet, functional
  feedback. Never the same fade on every section.
- **Emil:** before any animation, run the gate — *should it animate at all? what is the purpose?*
  If the purpose is only "looks cool" on a frequently-seen element, **write zero lines**.

They agree: RePhoto has **one authored moment (Recognition)** and a small, consistent set of
**functional** micro-interactions. Nothing decorative on anything users see dozens of times a day.

---

## 2. The token system (Emil's strong curves — built-in easings are too weak)

```css
--ease-out:    cubic-bezier(.23, 1, .32, 1);   /* entrances & exits, UI */
--ease-in-out: cubic-bezier(.77, 0, .175, 1);  /* on-screen move / morph */
--ease-drawer: cubic-bezier(.32, .72, 0, 1);   /* iOS-like drawer / bottom sheet */
--ease-std:    ease;                           /* hover / color only */
```
| Token | ms | Use |
| --- | --- | --- |
| `--dur-press` | 140 | button/press feedback (100–160) |
| `--dur-1` | 160 | small feedback |
| `--dur-2` | 220 | routine state, dropdowns, selects (150–250) |
| `--dur-3` | 300 | overlays / small layout (UI stays < 300) |
| `--dur-4` | 640 | the ONE authored entrance (Recognition) — marketing tier only |

Rules carried from Emil: **never `ease-in` on UI**; **never `scale(0)`** (start `scale(.95)` +
`opacity:0`); **exit faster than enter**; **only `transform`/`opacity`** (+ `clip-path`);
**transitions, not keyframes**, for rapidly-triggered UI (toasts); **`transform-origin` at the
trigger** for popovers/menus (modals stay centered); **stagger 30–80ms**; reduced-motion & hover
gating ship with every animation.

---

## 3. The authored moment — "Recognition" (landing only)

The product's promise is *we find you*. The landing stages it once, on load: a scan sweeps a wall
of real event photos; the ~5 where "you" appear resolve from dimmed+grayscale into full colour,
lift, and gain an accent ring, then a caption "N foto trovate in cui compari". This is the only
place that spends the 640ms / marketing-tier budget. Purpose: **explanation**. Reduced-motion:
matches resolve statically, no sweep. (Implemented: `[data-recognition]` in `motion.js`.)

Everywhere else, motion is one of the quiet patterns below.

---

## 4. Functional micro-interactions (the whole kit)

| Pattern | Where | Tool / value | Purpose |
| --- | --- | --- | --- |
| **Press** | every button/chip/cell | `transform: scale(.965)` on pointer-down, `--dur-press` `--ease-out` | feedback |
| **Hover** | buttons, nav, cards | color/background `--ease-std` ~150ms; card lift `translateY(-2px)` gated `@media (hover:hover)` | feedback |
| **Blur-up image load** | photo grids (home, gallery, moderation) | `img.blur-up`: `blur(12px)+scale(1.04)` → sharp, 500ms `--ease-out` on load | prevent jarring pop-in |
| **List reveal (stagger)** | gallery results, a row of cards appearing | fade + `translateY(12px)`, `--ease-out`, 30–80ms stagger, **once** | prevent jarring change |
| **Bottom sheet** | mobile ZIP/variant, actions | `translateY(100%)`→0, 420ms `--ease-drawer`; drag-to-dismiss = spring, velocity > .11 flicks | spatial consistency |
| **Modal** | confirms (delete, retention) | `scale(.96)+opacity` → center, `--dur-3` `--ease-out`, origin center; scrim fade | state |
| **Toast** | ZIP ready, consent saved | `translateY` in, **transition not keyframe**, exit faster; pause timer when tab hidden | feedback |
| **Count-up** | admin/photographer metrics | tabular numerals, ~900ms ease-out, once in view | state |
| **Progress bar** | uploads | width transition, `linear` for determinate | state |
| **Skeleton → content** | gallery queued, lists loading | shimmer `linear` loop; stop when content arrives; blur-up the real image in | prevent jarring change |
| **Selection tick** | gallery/moderation cells | dot scale + fill `--ease-out` 160ms | feedback |
| **Segmented / tab indicator** | gallery state, filters | move the active pill `--ease-in-out` ~200ms (or clip-path for seamless colour) | state |

**Explicitly NOT animated** (Emil's gate): keyboard-initiated actions, anything a photographer or
admin triggers dozens of times a minute during a session (row status changes use an instant colour
swap, not a transition), and raw data the user is reading.

---

## 5. Per-surface summary

- **Landing (Persuade):** Recognition (authored) + press + blur-up + one list reveal for the proof
  grid. Nothing else. No per-section scroll fades.
- **Participant mobile (Experience/Operate):** gallery results stagger-reveal **once**; blur-up on
  thumbnails; ZIP bottom-sheet with drag-to-dismiss; selection tick; queued→ready skeleton swap;
  selfie shutter press. Calm, fast.
- **Photographer (Operate):** this is a workspace used for hours — motion is minimal by design.
  Press feedback, determinate progress bars, count-up on the summary once. **Row state changes are
  instant** (no transition) because they fire constantly. Drop-zone dragenter is an instant border
  state. No decorative motion.
- **Admin (Operate):** press, count-up once on dashboard, modal confirms, toast on actions, tab/
  segment indicator. Tables don't animate rows. Destructive confirms use the modal (state + guard).

---

## 6. Performance & a11y (Emil)

- Animate only `transform`/`opacity`/`clip-path`; never `width/height/top/left/margin`.
- Don't drive a child's transform from a CSS var on the parent (recalcs all children) — set it on
  the element.
- CSS/WAAPI for predetermined motion (off the main thread, survives page-load jank); JS/springs only
  for dynamic, interruptible, gesture motion.
- In a future React port with Motion, use the **full `transform` string**, not `x`/`y`/`scale`
  shorthands (those drop frames under load).
- Every motion ships a `prefers-reduced-motion` path (keep opacity/colour, drop movement) and hover
  motion is gated `@media (hover:hover) and (pointer:fine)`.

---

## 7. Review ritual

Per Emil: review motion with fresh eyes the next day; play at 2–5× or frame-by-frame in DevTools;
test gestures (sheet drag) on a real phone. Per impeccable: one batched inspection round
(desktop+mobile), fix in one batch, stop. Settle entrance motion before any screenshot so a
mid-animation frame isn't mistaken for a missing element.
