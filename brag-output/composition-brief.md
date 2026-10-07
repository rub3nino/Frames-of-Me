# Hyperframes Composition Brief: Frames of Me

## Objective
Create a short, polished launch-style brag video for Frames of Me (framesofme.com), a self-hosted event-photo finder that uses face recognition so each attendee sees only the photos they appear in.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: ~22.5s

## Source Material
- Project root: /Users/rub/Progetti/rephoto (web app `apps/web`, marketing in `frontend/apps/landing`, participant flow in `frontend/apps/partecipanti`)
- Primary files read: frontend/apps/landing/index.html, frontend/packages/ui/tokens.css + landing.css, frontend/apps/partecipanti/src/pages/{Selfie,Galleria}.tsx, README.md
- Product name: Frames of Me (code name "Frames of Me"; use the new public brand)
- Tagline / strongest claim: "Le tue foto dell'evento, trovate in un selfie." / "Solo le foto in cui compari."
- Key UI/visual moments to recreate: the event photo wall, the common gallery, the participant Selfie camera-oval screen, the personal "Le tue foto" gallery, the privacy band, the bracket-and-dot camera-frame logo.
- Copy that must appear verbatim (from the real product):
  - "Dove sei, tra tutte queste foto?" (hook, adapted from "Solo le foto in cui compari")
  - "La galleria comune" / "Tutti caricano. Un unico album."
  - "Scatta un selfie" · "Tieni il viso nell'ovale, a circa 40 cm."
  - "Le tue foto" · "Solo le foto in cui compari."
  - "Il tuo viso resta tuo." · "Il selfie si cancella dopo la ricerca."
  - "Frames of Me" · "framesofme.com"

## Creative Direction
- Tone preset: polished (with app-store feature-card clarity on the two-worlds beats)
- Creative direction: quiet premium product film — your face is the key to your photos
- Interpretation: fewer scenes, longer settled holds, soft crossfades/slides, light-to-medium type, no aggression; the recognition moment is the one authored flourish.
- Angle: two worlds of one event album — the common gallery everyone uploads to, and the private-recognition folder where your face pulls out only yours.
- Hook: a dense wall of event photos floods in, then "Dove sei, tra tutte queste foto?"
- Outro / punchline: bracket-and-dot mark → "Frames of Me" → "Le tue foto dell'evento, trovate in un selfie." → framesofme.com
- Avoid: generic SaaS language; abstract filler visuals; any visual redesign away from the project's Apple-grade light identity; any real face/name/email (use fictional stand-ins and silhouette tiles).

## Visual Identity
- Background: #F5F5F7 (canvas); surfaces #FFFFFF
- Text: #1D1D1F (ink); secondary #6E6E73
- Accent: #0071E3 (blue); brand dot #5B7CFA (periwinkle)
- Display font: Instrument Serif (fallback Georgia serif)
- Body font: Geist (fallback system-ui); Geist Mono for tiny data labels
- Visual references: camera-frame bracket+dot mark; serif hero line; pastel feature tints (butter/sky/mint); rounded selfie camera-oval; photo-tile grids

## Storyboard
Use `brag-output/brag-plan.md` as the creative contract.
1. The wall / hook — 3.5s — photo wall floods in; "Dove sei, tra tutte queste foto?"; pill "Biruitori 2026 · 4.000+ scatti"
2. La galleria comune — 4s — shared album; chips drop photos in; "Tutti caricano. Un unico album."
3. Il selfie — 4.5s — camera-oval screen, hint, "Scatta un selfie"; shutter fires
4. Il riconoscimento → Le tue foto — 4.5s — wall dims, 5 matches ring blue; personal gallery assembles, thumbnails pop one by one, count ticks; "Solo le foto in cui compari."
5. Privacy — 3.5s — shield; "Il tuo viso resta tuo."; "Il selfie si cancella dopo la ricerca. Hosting in Europa."
6. Logo outro — 2.5s — mark + "Frames of Me" + tagline + framesofme.com

## Audio
- Audio role: warm, confident product-film bed with sparse, motion-matched accents
- Audio arc: fades in under the wall, communal-then-personal lift through the shutter and recognition, eases back for privacy, fades out on the logo settle
- Music: assets/music/music.mp3 (happy-beats-business-moves-vol-9, ~114.84 BPM)
- Music treatment: data-start 0, data-volume ~0.8, fade-in 0.4s, fade-out ~1.3s under the outro
- Music cue guidance: bundled preset (brag assets/music/cues/...vol-9...json). Strong cues: 4.23s (hook settles), 6.34s (into common gallery), 10.54s (selfie→recognition), 12.65s (gallery assembled). Sequential thumbnail pops snap ~0.45s apart from ~13.0s.
- Audio-reactive treatment: subtle — recognition glow may breathe gently; no waveform bars. (If extraction unavailable, skip; do not block render.)
- Audio-coupled moments:
  - S3 selfie — simulated button press + capture (press.ogg + capture.ogg)
  - S4 recognition — reveal payoff (reveal.ogg) + sequential thumbnail ticks (tick.ogg)
  - S2 common gallery — soft photo-join ticks (tick.ogg, quiet)
  - S6 outro — one soft logo settle (settle.ogg)
- SFX selection guidance: all low/medium HF risk (polished): press=ui/click2, tick=interface/click_003, reveal/capture/settle=impactSoft_medium. Fire ticks at the visual landing.
- SFX analysis guidance: /Users/rub/.claude/skills/brag/assets/sfx/sfx-analysis.md
- Audio files: copied into assets/music/ and assets/sfx/.

## Hyperframes Instructions
Single root timeline (`window.__timelines["main"]`), paused, GSAP, deterministic (no Math.random/Date.now/network beyond the gsap+fonts CDN). Scenes as stacked full-frame `.clip` containers crossfaded via opacity. Show real UI (selfie screen, personal gallery, privacy band). Keep all text readable (holds at the reading-time floor). `hyperframes check` must pass before render.
