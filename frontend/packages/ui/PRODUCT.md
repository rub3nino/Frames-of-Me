# Frames of Me — Product context

> Durable product knowledge for anyone (human or AI) designing or building the UI.
> Style of this file follows the impeccable convention: audience, purpose,
> constraints and voice — not surface visuals. Visual system lives in
> [`brand/DESIGN.md`](brand/DESIGN.md); flows live in [`../docs/ux-flows.md`](../docs/ux-flows.md).

## What it is
Frames of Me lets people **find the event photos they appear in, by selfie, and download them** —
and lets photographers upload the shoot and admins run the whole thing. Built for one
conference: 3 days, ~12 photographers, ~150k photos, ~6.000 participants.

## Who uses it (three audiences, one landing)
1. **Participant** — a guest at the conference. Mostly non-technical, on a phone, on venue
   wifi. Wants *their* photos with the least friction. Cares that their face data is treated
   with respect. Emotional job: *the small delight of rediscovering yourself in a great shot.*
2. **Photographer** — invited pro, on a laptop, uploading thousands of files between sessions.
   Wants speed, resume-on-failure, and a clear "what's done / what failed" signal. Does not
   care about face-matching internals.
3. **Admin** — you + 3 colleagues, equal powers, on desktop. Configure events, invite
   photographers, (optionally) restrict access, watch the numbers, honor GDPR.

## Why it must feel trustworthy
It processes **biometric data** (facial templates — GDPR Art. 9 special category) for
thousands of strangers. Trust is a feature, not a nicety: explicit consent, "your selfie is
not kept", clear data controls, calm and honest copy. Never dark-pattern a consent.

## Constraints that shape the UI (from CONTRACTS.md / v2-spec.md)
- **No passwords.** Auth is magic-link (participant/admin) or invite link (photographer).
- Participant path is *forced*: email → magic link → biometric consent → selfie → gallery.
- Selfie needs a signed-in user **and** a consent row, else 403. Rate-limited.
- Gallery has three states: `empty` / `queued` / `ready`. New photos attach over time.
- Photographer uploads need event membership; dedupe by sha256; resumable.
- Admin API today is thin: metrics, invite, delete, retention. **Missing: create event,
  list endpoints, admin bootstrap, GDPR self-service** (see ux-flows §9). The UI is designed
  for the target state and these gaps are flagged, not hidden.
- UI language: **Italian**. Code/identifiers: English.

## Voice & tone
Calm, human, plainspoken Italian. Short sentences. Confident, never hype. Explains the *why*
of anything sensitive (consent, data). Warm but not cute. Examples:
- Good: "Scatta un selfie: lo usiamo solo per trovarti e poi lo cancelliamo."
- Avoid: "La nostra AI rivoluzionaria analizza il tuo volto!"

## Emotion per world
- Participant: **calm + delight** — effortless, then a little joy at the reveal.
- Photographer: **control + momentum** — fast, legible, never anxious about a failed upload.
- Admin: **clarity + confidence** — everything legible at a glance, destructive actions guarded.

## Success looks like
A guest scans a QR, takes one selfie, and is looking at their photos within a minute —
and never worries about where their face went.
