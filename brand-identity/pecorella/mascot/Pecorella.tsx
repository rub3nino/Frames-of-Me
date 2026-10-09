/**
 * Pecorella — mascotte animata di Frames of Me.
 *
 * Componente standalone (nessuna dipendenza oltre a react): SVG inline
 * + classi di stato definite in ./pecorella.css. Le forme, i colori e le
 * proporzioni sono quelli approvati in pecorella.svg: qui si anima, non
 * si ridisegna.
 *
 * <Pecorella azione="cammina" dimensione={240} />
 *
 * - `scuoti` parte, dura ~900ms e torna da solo a idle (animationend).
 *   Per rilanciarlo, riportare `azione` a "idle" e poi di nuovo a "scuoti"
 *   (o smontare/rimontare con una key).
 * - `attraversa` = cammina + traversata del contenitore: il contenitore
 *   dovrebbe avere `container-type: inline-size` (altrimenti 100cqw vale
 *   la larghezza del viewport).
 * - Regola di brand: mai due pecorelle nella stessa schermata.
 */
import * as React from 'react';
import './pecorella.css';

export type PecorellaAzione =
  | 'idle'
  | 'cammina'
  | 'attraversa'
  | 'scuoti'
  | 'testa'
  | 'triste';

export interface PecorellaProps {
  azione?: PecorellaAzione;
  /** larghezza in px (l'altezza segue il viewBox 420x340) */
  dimensione?: number;
  className?: string;
}

const CLASSI_AZIONE: Record<PecorellaAzione, string> = {
  idle: '',
  cammina: 'pecorella--cammina',
  attraversa: 'pecorella--cammina pecorella--attraversa',
  scuoti: 'pecorella--scuoti',
  testa: 'pecorella--testa',
  triste: 'pecorella--triste',
};

export function Pecorella({
  azione = 'idle',
  dimensione = 240,
  className,
}: PecorellaProps): React.JSX.Element {
  const [scuotiFinito, setScuotiFinito] = React.useState(false);

  // ogni cambio di azione riarma lo scuotimento
  React.useEffect(() => {
    setScuotiFinito(false);
  }, [azione]);

  const effettiva: PecorellaAzione =
    azione === 'scuoti' && scuotiFinito ? 'idle' : azione;

  const onAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.animationName === 'pecorella-scuoti-corpo') setScuotiFinito(true);
  };

  const classi = ['pecorella', CLASSI_AZIONE[effettiva], className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classi}
      style={{ width: dimensione }}
      onAnimationEnd={onAnimationEnd}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 420 340"
        role="img"
        aria-label="Pecorella Frames of Me"
      >
        {/* ===== ZAMPE (dietro il corpo) =====
            I wrapper *-pos portano la posa scelta dal cliente nell'editor
            (layout.json 2026-10-08); i gruppi interni restano liberi per le
            animazioni CSS. */}
        <g id="zampe">
          <g
            id="zampa-pd-pos"
            transform="translate(-6.1 -4.9) translate(298 264) rotate(-3.5) translate(-298 -264)"
          >
            <g id="zampa-pd" className="zampa">
              <rect x="288" y="230" width="20" height="66" rx="10" fill="#9C8F7E" />
              <path
                d="M 288 280 h 20 v 8 a 10 10 0 0 1 -10 10 a 10 10 0 0 1 -10 -10 z"
                fill="#241E18"
              />
            </g>
          </g>
          <g id="zampa-ad-pos" transform="translate(-6.3 4.9)">
            <g id="zampa-ad" className="zampa">
              <rect x="200" y="232" width="20" height="64" rx="10" fill="#9C8F7E" />
              <path
                d="M 200 278 h 20 v 8 a 10 10 0 0 1 -10 10 a 10 10 0 0 1 -10 -10 z"
                fill="#241E18"
              />
            </g>
          </g>
          <g id="zampa-ps-pos" transform="translate(-4 0)">
            <g id="zampa-ps" className="zampa">
              <rect x="256" y="234" width="21" height="64" rx="10" fill="#AC9F8E" />
              <path
                d="M 256 280 h 21 v 8 a 10.5 10.5 0 0 1 -10.5 10 a 10.5 10.5 0 0 1 -10.5 -10 z"
                fill="#241E18"
              />
            </g>
          </g>
          <g
            id="zampa-as-pos"
            transform="translate(-8 -5) translate(178.5 266) rotate(6) translate(-178.5 -266)"
          >
            <g id="zampa-as" className="zampa">
              <rect x="168" y="234" width="21" height="64" rx="10" fill="#AC9F8E" />
              <path
                d="M 168 280 h 21 v 8 a 10.5 10.5 0 0 1 -10.5 10 a 10.5 10.5 0 0 1 -10.5 -10 z"
                fill="#241E18"
              />
            </g>
          </g>
        </g>

        {/* ===== CORPO: nuvola di lana ===== */}
        <g
          id="corpo-pos"
          transform="translate(-0.1 0) translate(233 189) scale(0.87) translate(-233 -189)"
        >
        <g id="corpo">
          <circle cx="166" cy="196" r="44" fill="#F7F0E2" />
          <circle cx="196" cy="158" r="46" fill="#F7F0E2" />
          <circle cx="243" cy="146" r="48" fill="#F7F0E2" />
          <circle cx="288" cy="164" r="44" fill="#F7F0E2" />
          <circle cx="306" cy="200" r="38" fill="#F7F0E2" />
          <circle cx="282" cy="228" r="40" fill="#F7F0E2" />
          <circle cx="232" cy="238" r="42" fill="#F7F0E2" />
          <circle cx="184" cy="228" r="38" fill="#F7F0E2" />
          <circle cx="234" cy="192" r="66" fill="#F7F0E2" />
          <g id="macchie">
            <circle cx="300" cy="182" r="7" fill="#EFE6D4" />
            <circle cx="314" cy="198" r="5.5" fill="#EFE6D4" />
            <circle cx="301" cy="206" r="4.5" fill="#EFE6D4" />
          </g>
        </g>
        </g>

        {/* ===== TESTA ===== */}
        <g id="testa">
          <g
            id="orecchio-sx-pos"
            transform="translate(-11.9 49) translate(106 78) rotate(-8) translate(-106 -78)"
          >
            <g id="orecchio-sx">
              <ellipse
                cx="106"
                cy="78"
                rx="17"
                ry="30"
                fill="#AC9F8E"
                transform="rotate(42 106 78)"
              />
            </g>
          </g>
          <g id="muso-pos" transform="translate(0.2 1.3)">
            <ellipse
              id="muso"
              cx="152"
              cy="142"
              rx="43"
              ry="54"
              fill="#AC9F8E"
              transform="rotate(-8 152 142)"
            />
          </g>
          <g
            id="orecchio-dx-pos"
            transform="translate(-10.6 3.9) translate(222 148) rotate(-30.5) translate(-222 -148)"
          >
            <g id="orecchio-dx">
              <ellipse
                cx="222"
                cy="148"
                rx="16"
                ry="30"
                fill="#AC9F8E"
                transform="rotate(22 222 148)"
              />
              <ellipse
                cx="224"
                cy="152"
                rx="9.5"
                ry="21"
                fill="#9C8F7E"
                transform="rotate(22 224 152)"
              />
            </g>
          </g>
          <g id="ciuffo">
            <circle cx="122" cy="108" r="23" fill="#F7F0E2" />
            <circle cx="150" cy="96" r="27" fill="#F7F0E2" />
            <circle cx="182" cy="102" r="25" fill="#F7F0E2" />
            <circle cx="206" cy="120" r="22" fill="#F7F0E2" />
          </g>
          <g id="occhi">
            <g id="occhio-sx">
              <ellipse cx="131" cy="138" rx="13" ry="15" fill="#2A241E" />
              <circle cx="126.5" cy="132" r="4.6" fill="#FFFFFF" />
              <circle cx="135" cy="144" r="2" fill="#FFFFFF" />
            </g>
            <g id="occhio-dx">
              <ellipse cx="173" cy="146" rx="13" ry="15" fill="#2A241E" />
              <circle cx="168.5" cy="140" r="4.6" fill="#FFFFFF" />
              <circle cx="177" cy="152" r="2" fill="#FFFFFF" />
            </g>
          </g>
          <g id="sorriso-pos" transform="translate(-45.5 -3.9)">
            <path
              id="sorriso"
              d="M 182 172 q 9 8 19 1"
              fill="none"
              stroke="#2A241E"
              strokeWidth="3.4"
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}

export interface PecorellaMarkProps {
  /** larghezza in px (l'altezza segue il viewBox 168x152) */
  dimensione?: number;
  className?: string;
}

/**
 * PecorellaMark — solo testa (da logo/mark.svg): favicon, FAB, avatar.
 * Statico per regola di brand: il marchio non ruota e non si anima.
 */
export function PecorellaMark({
  dimensione = 32,
  className,
}: PecorellaMarkProps): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 168 152"
      role="img"
      aria-label="Frames of Me"
      width={dimensione}
      className={className}
    >
      <g>
        <circle cx="58" cy="122" r="22" fill="#F7F0E2" />
        <circle cx="92" cy="128" r="24" fill="#F7F0E2" />
        <circle cx="124" cy="116" r="20" fill="#F7F0E2" />
      </g>
      <ellipse cx="22" cy="74" rx="15" ry="26" fill="#AC9F8E" transform="rotate(34 22 74)" />
      <ellipse cx="76" cy="88" rx="40" ry="50" fill="#AC9F8E" transform="rotate(-8 76 88)" />
      <ellipse cx="131" cy="97" rx="14" ry="26" fill="#AC9F8E" transform="rotate(-8.5 131 97)" />
      <ellipse cx="133" cy="100.5" rx="8.5" ry="18" fill="#9C8F7E" transform="rotate(-8.5 133 100.5)" />
      <g>
        <circle cx="46" cy="54" r="20" fill="#F7F0E2" />
        <circle cx="72" cy="42" r="24" fill="#F7F0E2" />
        <circle cx="101" cy="47" r="22" fill="#F7F0E2" />
        <circle cx="123" cy="64" r="19" fill="#F7F0E2" />
      </g>
      <g>
        <ellipse cx="57" cy="86" rx="12" ry="14" fill="#2A241E" />
        <circle cx="52.8" cy="80.5" r="4.2" fill="#FFFFFF" />
        <circle cx="60.6" cy="91.5" r="1.8" fill="#FFFFFF" />
        <ellipse cx="96" cy="93" rx="12" ry="14" fill="#2A241E" />
        <circle cx="91.8" cy="87.5" r="4.2" fill="#FFFFFF" />
        <circle cx="99.6" cy="98.5" r="1.8" fill="#FFFFFF" />
      </g>
      <path
        d="M 61.5 112.5 q 8.5 7.5 17.5 1"
        fill="none"
        stroke="#2A241E"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default Pecorella;
