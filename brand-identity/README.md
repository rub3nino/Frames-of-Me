# Frames of Me — Brand Identity

Identità visiva di **Frames of Me** (framesofme.com).

> **⭐ Direzione attiva (ott 2026): ["Prato" — la pecorella](pecorella/BRAND-IDENTITY.md).**
> Mascotte pecorella = logo e guida dell'esperienza. Token: [`pecorella/tokens.css`](pecorella/tokens.css) ·
> Analisi delle 4 immagini di riferimento: [`analysis/style-extraction.json`](analysis/style-extraction.json) ·
> Mascotte animabile: [`pecorella/mascot/`](pecorella/mascot/) · Logo: [`pecorella/logo/`](pecorella/logo/).
> Il frontend che la implementa è `frontend-angular/` alla radice del repo.
> Le sezioni sotto ("cornice di messa a fuoco" e vetrina "Cielo") sono proposte precedenti, tenute come storico.

## Cosa c'è qui

| File | Cosa |
| --- | --- |
| **`pecorella/`** | **La brand identity attiva**: manuale, token, logo, mascotte animata. |
| `analysis/style-extraction.json` | Style guide estratte dalle 4 immagini di riferimento del cliente. |
| **`frames-of-me.html`** | Il deliverable: un singolo file HTML+CSS self-contained con tutta la brand identity (logo, colore, tipografia, fotografia, motion, voce, componenti) **e** il redesign mobile-first di ogni pagina di sito e app. |
| `photos/` | 25 foto **reali** scaricate da Pexels (13 ritratti + 12 eventi). Nessun placeholder. |
| `CREDITS.md` | Attribuzioni di tutte le foto. |

## Come guardarla

Apri `frames-of-me.html` in un browser. Se le foto non compaiono (apertura come `file://`),
servi la cartella:

```bash
cd brand-identity && python3 -m http.server 8777
```

poi apri http://localhost:8777/frames-of-me.html

## La direzione in una riga

**Caldo · Chiaro · Fidato** — una "galleria d'autore" calda (carta avorio, inchiostro caldo,
**una sola** honey come accento) dove la foto è la protagonista. Il marchio è una **cornice di
messa a fuoco** (mirino + quadro) riusata ovunque: logo, scatto del selfie, selezione, "match".
Tipografia: *Instrument Serif* per l'emozione (solo display) + *Geist* per UI/dati.

È una proposta alternativa alla direzione attuale ("Apple-grade freddo, un blu"): stessa
precisione, ma rimette al centro l'emozione del ritrovarsi.
