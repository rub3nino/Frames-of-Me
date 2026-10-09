# Pecorella animata

Mascotte di Frames of Me come componente animato 2D. Tre pezzi:

| File | Cosa |
|---|---|
| `pecorella.css` | Tutte le keyframes e le classi di stato (solo `transform`/`opacity`) |
| `Pecorella.tsx` | Componente React standalone (`Pecorella` + `PecorellaMark`) |
| `pecorella-animata.html` | Demo senza build per QA visivo e porting |

## Uso in React

```tsx
import { Pecorella, PecorellaMark } from './Pecorella';

<Pecorella azione="idle" dimensione={240} />      // login/onboarding
<Pecorella azione="attraversa" />                  // attesa: progress bar emotiva
<Pecorella azione="scuoti" />                      // match trovato (one-shot, torna a idle)
<Pecorella azione="triste" />                      // errore / zero risultati
<PecorellaMark dimensione={28} />                  // solo testa: FAB, avatar (statico)
```

- `azione`: `'idle' | 'cammina' | 'attraversa' | 'scuoti' | 'testa' | 'triste'` (default `idle`).
- `scuoti` dura ~900 ms e rientra da solo in idle (`animationend` di
  `pecorella-scuoti-corpo`). Per rilanciarlo riporta la prop a `idle` e poi di
  nuovo a `scuoti`, o rimonta con una `key`.
- `attraversa` trasla il wrapper da fuori-sinistra a fuori-destra del
  contenitore: dai al contenitore `container-type: inline-size` e
  `overflow: hidden` (senza container, `100cqw` ricade sul viewport).
  Durante la traversata l'SVG è specchiato (`scaleX(-1)`) per camminare nel
  verso di marcia.
- `prefers-reduced-motion: reduce`: tutto fermo, resta solo un respiro
  d'opacità lentissimo (regola di brand).
- I token di `tokens.css` (`--ease-bounce`, `--dur-mascot-*`), se presenti nel
  `:root`, vincono sui fallback locali dichiarati in `pecorella.css`.
- Regola di brand: mai due pecorelle nella stessa schermata (il CSS usa gli
  id dell'SVG, scopati sotto `.pecorella`).

## Porting in Angular

La logica è tutta nel CSS: il componente è solo "SVG inline + classe di stato".

1. Copia `pecorella.css` negli stili globali (o nel componente con
   `encapsulation: ViewEncapsulation.None`, perché i selettori usano gli id
   dell'SVG).
2. Crea `pecorella.component.ts` con il template = markup SVG di
   `pecorella-animata.html` dentro `<div class="pecorella" [ngClass]="classi">`.
3. Replica la mappa stato→classi:

```ts
@Input() azione: Azione = 'idle';

classi(): string {
  return {
    idle: '', cammina: 'pecorella--cammina',
    attraversa: 'pecorella--cammina pecorella--attraversa',
    scuoti: 'pecorella--scuoti', testa: 'pecorella--testa',
    triste: 'pecorella--triste',
  }[this.azione];
}

@HostListener('animationend', ['$event'])
fineScuoti(e: AnimationEvent) {
  if (e.animationName === 'pecorella-scuoti-corpo') { /* torna a idle */ }
}
```

La demo `pecorella-animata.html` è il riferimento di comportamento: stessa
mappa classi, stesso `animationend`.
