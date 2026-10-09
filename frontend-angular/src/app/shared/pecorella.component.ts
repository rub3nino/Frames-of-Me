import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Pecorella — la mascotte di Frames of Me (vedi brand-identity/pecorella).
 * Le animazioni vivono in assets/mascot/pecorella.css (importato in styles.css)
 * e pilotano gli id originali dell'illustrazione: idle di default, più gli
 * stati 'cammina' | 'attraversa' | 'scuoti' | 'triste' via input [mode].
 * Con prefers-reduced-motion resta ferma con il solo respiro d'opacità.
 * Palette fissa dell'illustrazione (token --wool / --muzzle / --hoof): non si ricolora.
 */
@Component({
  selector: 'app-pecorella',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pecorella" [class]="stateClass()" [style.width.px]="size()">
      <svg viewBox="0 0 420 340" xmlns="http://www.w3.org/2000/svg" role="img"
           aria-label="Pecorella, la mascotte di Frames of Me">
        <!-- zampe (i wrapper *-pos portano la posa scelta dal cliente nell'editor:
             layout.json del 2026-10-08; i gruppi interni restano liberi per le animazioni) -->
        <g id="zampe">
          <g id="zampa-pd-pos" transform="translate(-6.1 -4.9) translate(298 264) rotate(-3.5) translate(-298 -264)">
            <g id="zampa-pd" class="zampa">
              <rect x="288" y="230" width="20" height="66" rx="10" fill="var(--muzzle-deep)" />
              <path d="M 288 280 h 20 v 8 a 10 10 0 0 1 -10 10 a 10 10 0 0 1 -10 -10 z" fill="var(--hoof)" />
            </g>
          </g>
          <g id="zampa-ad-pos" transform="translate(-6.3 4.9)">
            <g id="zampa-ad" class="zampa">
              <rect x="200" y="232" width="20" height="64" rx="10" fill="var(--muzzle-deep)" />
              <path d="M 200 278 h 20 v 8 a 10 10 0 0 1 -10 10 a 10 10 0 0 1 -10 -10 z" fill="var(--hoof)" />
            </g>
          </g>
          <g id="zampa-ps-pos" transform="translate(-4 0)">
            <g id="zampa-ps" class="zampa">
              <rect x="256" y="234" width="21" height="64" rx="10" fill="var(--muzzle)" />
              <path d="M 256 280 h 21 v 8 a 10.5 10.5 0 0 1 -10.5 10 a 10.5 10.5 0 0 1 -10.5 -10 z" fill="var(--hoof)" />
            </g>
          </g>
          <g id="zampa-as-pos" transform="translate(-8 -5) translate(178.5 266) rotate(6) translate(-178.5 -266)">
            <g id="zampa-as" class="zampa">
              <rect x="168" y="234" width="21" height="64" rx="10" fill="var(--muzzle)" />
              <path d="M 168 280 h 21 v 8 a 10.5 10.5 0 0 1 -10.5 10 a 10.5 10.5 0 0 1 -10.5 -10 z" fill="var(--hoof)" />
            </g>
          </g>
        </g>

        <!-- corpo: nuvola di lana -->
        <g id="corpo-pos" transform="translate(-0.1 0) translate(233 189) scale(0.87) translate(-233 -189)">
        <g id="corpo">
          <circle cx="166" cy="196" r="44" fill="var(--wool)" />
          <circle cx="196" cy="158" r="46" fill="var(--wool)" />
          <circle cx="243" cy="146" r="48" fill="var(--wool)" />
          <circle cx="288" cy="164" r="44" fill="var(--wool)" />
          <circle cx="306" cy="200" r="38" fill="var(--wool)" />
          <circle cx="282" cy="228" r="40" fill="var(--wool)" />
          <circle cx="232" cy="238" r="42" fill="var(--wool)" />
          <circle cx="184" cy="228" r="38" fill="var(--wool)" />
          <circle cx="234" cy="192" r="66" fill="var(--wool)" />
          <g id="macchie">
            <circle cx="300" cy="182" r="7" fill="var(--wool-shade)" />
            <circle cx="314" cy="198" r="5.5" fill="var(--wool-shade)" />
            <circle cx="301" cy="206" r="4.5" fill="var(--wool-shade)" />
          </g>
        </g>
        </g>

        <!-- testa -->
        <g id="testa">
          <g id="orecchio-sx-pos" transform="translate(-11.9 49) translate(106 78) rotate(-8) translate(-106 -78)">
            <g id="orecchio-sx">
              <ellipse cx="106" cy="78" rx="17" ry="30" fill="var(--muzzle)" transform="rotate(42 106 78)" />
            </g>
          </g>
          <g id="muso-pos" transform="translate(0.2 1.3)">
            <ellipse id="muso" cx="152" cy="142" rx="43" ry="54" fill="var(--muzzle)" transform="rotate(-8 152 142)" />
          </g>
          <g id="orecchio-dx-pos" transform="translate(-10.6 3.9) translate(222 148) rotate(-30.5) translate(-222 -148)">
            <g id="orecchio-dx">
              <ellipse cx="222" cy="148" rx="16" ry="30" fill="var(--muzzle)" transform="rotate(22 222 148)" />
              <ellipse cx="224" cy="152" rx="9.5" ry="21" fill="var(--muzzle-deep)" transform="rotate(22 224 152)" />
            </g>
          </g>
          <g id="ciuffo">
            <circle cx="122" cy="108" r="23" fill="var(--wool)" />
            <circle cx="150" cy="96" r="27" fill="var(--wool)" />
            <circle cx="182" cy="102" r="25" fill="var(--wool)" />
            <circle cx="206" cy="120" r="22" fill="var(--wool)" />
          </g>
          <g id="occhi">
            <g id="occhio-sx">
              <ellipse cx="131" cy="138" rx="13" ry="15" fill="var(--text-primary)" />
              <circle cx="126.5" cy="132" r="4.6" fill="var(--surface-raised)" />
              <circle cx="135" cy="144" r="2" fill="var(--surface-raised)" />
            </g>
            <g id="occhio-dx">
              <ellipse cx="173" cy="146" rx="13" ry="15" fill="var(--text-primary)" />
              <circle cx="168.5" cy="140" r="4.6" fill="var(--surface-raised)" />
              <circle cx="177" cy="152" r="2" fill="var(--surface-raised)" />
            </g>
          </g>
          <g id="sorriso-pos" transform="translate(-45.5 -3.9)">
            <path id="sorriso" d="M 182 172 q 9 8 19 1" fill="none" stroke="var(--text-primary)" stroke-width="3.4" stroke-linecap="round" />
          </g>
        </g>
      </svg>
    </div>
  `,
  styles: `
    :host { display: inline-block; line-height: 0; }
  `,
})
export class PecorellaComponent {
  /** Larghezza in px del riquadro mascotte. */
  readonly size = input(160);

  /** Stato di animazione (vedi assets/mascot/pecorella.css). */
  readonly mode = input<'idle' | 'cammina' | 'attraversa' | 'scuoti' | 'triste'>('idle');

  protected readonly stateClass = computed(() => {
    const m = this.mode();
    if (m === 'idle') return '';
    if (m === 'attraversa') return 'pecorella--cammina pecorella--attraversa';
    return `pecorella--${m}`;
  });
}
