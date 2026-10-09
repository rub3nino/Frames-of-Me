import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { RevealDirective } from '../../shared/reveal.directive';
import { PecorellaComponent } from '../../shared/pecorella.component';

interface Sponsor {
  name: string;
  src: string;
}

/**
 * Landing "Cielo, il momento del match" — porting della proposta approvata
 * (brand-identity/proposta-landing).
 *
 * Regia del movimento:
 * - GSAP + ScrollTrigger SOLO per lo scroll-driven (hero "momento del match",
 *   filo dei tre gesti) e per i micro-feedback pointer-fine (tilt, CTA magnetica).
 * - Reveal e polaroid restano su RevealDirective (IntersectionObserver).
 * - Tutto gira fuori da Angular zone: nessun change detection per frame.
 * - prefers-reduced-motion: niente GSAP, niente scrub/pin; il CSS è la verità
 *   (mirino agganciato, pila composta, filo disegnato) e i contatori mostrano
 *   subito il valore finale. Dissolvenze ≤150ms via regola globale.
 * - Cleanup completo in ngOnDestroy: matchMedia revert, kill di ogni
 *   ScrollTrigger, AbortController per i listener pointer.
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, RevealDirective, PecorellaComponent],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing implements OnDestroy {
  /** Loghi sponsor fittizi (SVG monocromi in assets/sponsor, sostituibili). */
  readonly sponsors: Sponsor[] = [
    { name: 'Nordwind', src: 'assets/sponsor/nordwind.svg' },
    { name: 'Caffè Aurora', src: 'assets/sponsor/caffe-aurora.svg' },
    { name: 'StudioLuce', src: 'assets/sponsor/studioluce.svg' },
    { name: 'Birrificio Ponte', src: 'assets/sponsor/birrificio-ponte.svg' },
    { name: 'Hotel Miramonti', src: 'assets/sponsor/miramonti.svg' },
    { name: 'Fioralba', src: 'assets/sponsor/fioralba.svg' },
    { name: 'Velotta', src: 'assets/sponsor/velotta.svg' },
    { name: 'Lumen Eventi', src: 'assets/sponsor/lumen-eventi.svg' },
  ];

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);

  /** Revert unico di tutto ciò che GSAP ha creato (timeline, trigger, set). */
  private mm?: gsap.MatchMedia;
  /** Stacca i listener pointer/resize/load alla distruzione. */
  private readonly ac = new AbortController();
  private countersIO?: IntersectionObserver;

  constructor() {
    afterNextRender(() => this.zone.runOutsideAngular(() => this.init()));
  }

  ngOnDestroy(): void {
    this.ac.abort();
    this.countersIO?.disconnect();
    this.mm?.revert();
    ScrollTrigger.getAll().forEach((t) => t.kill());
  }

  private init(): void {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

    this.setupCounters(reduce);
    if (reduce) return; // CSS = verità: stati finali statici, dissolvenze ≤150ms

    gsap.registerPlugin(ScrollTrigger);
    this.host.classList.add('anim-on');
    this.mm = gsap.matchMedia();

    try {
      this.setupHero();
    } catch {
      this.host.classList.add('hero-fallback');
    }
    this.setupThread();
    if (fine) {
      this.setupTilt();
      this.setupMagnet();
    }

    // le foto arrivano dopo il primo layout: rimisura i trigger
    window.addEventListener('load', () => ScrollTrigger.refresh(), {
      once: true,
      signal: this.ac.signal,
    });
  }

  /* ---------- numeri che contano (tabulari, it-IT) ----------
     Raggruppamento manuale: l'italiano CLDR non separa i numeri
     a 4 cifre («6000»), ma la pagina scrive «6.000». */
  private setupCounters(reduce: boolean): void {
    const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const counters = Array.from(this.host.querySelectorAll<HTMLElement>('[data-count]'));
    if (!counters.length) return;

    const run = (el: HTMLElement) => {
      const end = parseInt(el.dataset['count'] ?? '0', 10);
      if (reduce || typeof requestAnimationFrame === 'undefined') {
        el.textContent = fmt(end);
        return;
      }
      const t0 = performance.now();
      const dur = 900;
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3); // ease-out cubico
        el.textContent = fmt(Math.round(end * eased));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    if (reduce || typeof IntersectionObserver === 'undefined') {
      counters.forEach(run);
      return;
    }
    this.countersIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            run(e.target as HTMLElement);
            this.countersIO?.unobserve(e.target);
          }
        }
      },
      { threshold: 0.6 },
    );
    counters.forEach((el) => this.countersIO?.observe(el));
  }

  /* ============================================================
     HERO — il momento del match (scrub).
     Il mirino viaggia tra i volti, si aggancia, e quattro scatti
     volano nella pila personale con la chip «47 foto con te».
     Waypoint in frazioni della foto (misurati su event-01).
     ============================================================ */
  private setupHero(): void {
    const q = (sel: string) => this.host.querySelector<HTMLElement>(sel);
    const photo = q('.stage-photo > img');
    const stage = q('.stage');
    const vf = q('.vf');
    const sky = q('.vf-layer-sky');
    const act = q('.vf-layer-action');
    const ring = q('.vf-ring');
    const vfChip = q('.vf-chip');
    const stackChip = q('.stack-chip');
    const minis = Array.from(this.host.querySelectorAll<HTMLElement>('.mini'));
    if (!photo || !stage || !vf || !sky || !act || !ring || !vfChip || !stackChip || minis.length < 4) {
      throw new Error('hero: markup incompleto');
    }

    /* target del mirino (CSS): left 60% / top 49% della foto */
    const TARGET = { x: 0.6, y: 0.49 };
    const WAYPOINTS = [
      { x: 0.28, y: 0.19 },
      { x: 0.84, y: 0.385 },
    ];
    const dx = (p: { x: number }) => () => (p.x - TARGET.x) * photo.clientWidth;
    const dy = (p: { y: number }) => () => (p.y - TARGET.y) * photo.clientHeight;

    /* delta pila → centro foto (le mini partono "dal match") */
    const fromX = (_i: number, el: Element) => {
      const a = photo.getBoundingClientRect();
      const b = (el as HTMLElement).getBoundingClientRect();
      return a.left + a.width * TARGET.x - (b.left + b.width / 2);
    };
    const fromY = (_i: number, el: Element) => {
      const a = photo.getBoundingClientRect();
      const b = (el as HTMLElement).getBoundingClientRect();
      return a.top + a.height * TARGET.y - (b.top + b.height / 2);
    };

    const buildTimeline = (st: ScrollTrigger.Vars) => {
      const tl = gsap.timeline({ scrollTrigger: st, defaults: { ease: 'none' } });

      /* 1. il mirino cerca: viaggia tra i volti */
      tl.fromTo(
        vf,
        { x: dx(WAYPOINTS[0]), y: dy(WAYPOINTS[0]), scale: 1.14 },
        { x: dx(WAYPOINTS[1]), y: dy(WAYPOINTS[1]), scale: 1.05, duration: 1 },
        0,
      ).to(vf, { x: 0, y: 0, scale: 1, duration: 1 }, 1);

      /* 2. aggancio: crossfade cielo→azione, impulso, «Sei tu» */
      tl.to(sky, { opacity: 0, duration: 0.12 }, 2)
        .to(act, { opacity: 1, duration: 0.12 }, 2)
        .to(vf, { scale: 0.92, duration: 0.18, ease: 'power1.out' }, 2)
        .fromTo(
          ring,
          { opacity: 0.85, scale: 0.88 },
          { opacity: 0, scale: 1.16, duration: 0.4, ease: 'power1.out' },
          2,
        )
        .fromTo(
          vfChip,
          { autoAlpha: 0, y: -6 },
          { autoAlpha: 1, y: 0, duration: 0.25, ease: 'power1.out' },
          2.1,
        );

      /* 3. gli scatti volano nella pila personale
         (set iniziale esplicito: il CSS li pre-nasconde) */
      const ROTS = [-6, 4, -2, 2.5];
      gsap.set(minis, { x: fromX, y: fromY, rotation: 0, scale: 0.5, autoAlpha: 0 });
      tl.to(
        minis,
        {
          x: 0,
          y: 0,
          rotation: (i: number) => ROTS[i],
          scale: 1,
          autoAlpha: 1,
          duration: 0.75,
          stagger: 0.22,
          ease: 'power1.inOut',
        },
        2.45,
      ).fromTo(
        stackChip,
        { autoAlpha: 0, scale: 0.94, y: 8 },
        { autoAlpha: 1, scale: 1, y: 0, duration: 0.3, ease: 'power1.out' },
        3.75,
      );

      return tl;
    };

    /* desktop: pin breve del hero; mobile: niente pin, scrub in ingresso */
    this.mm?.add('(min-width: 920px)', () => {
      buildTimeline({
        trigger: '.hero',
        start: 'top 64px',
        end: '+=110%',
        pin: true,
        anticipatePin: 1,
        scrub: 0.5,
        invalidateOnRefresh: true,
      });
    });
    this.mm?.add('(max-width: 919px)', () => {
      buildTimeline({
        trigger: stage,
        start: 'top 88%',
        end: 'top 28%',
        scrub: 0.6,
        invalidateOnRefresh: true,
      });
    });
  }

  /* ============================================================
     TRE GESTI — il filo si disegna allo scroll e porta un
     pallino che accende i numeri al passaggio.
     ============================================================ */
  private setupThread(): void {
    const steps = this.host.querySelector<HTMLElement>('.steps');
    const dot = this.host.querySelector<HTMLElement>('.thread-dot');
    const stepEls = Array.from(this.host.querySelectorAll<HTMLElement>('[data-step]'));
    if (!steps || !dot || !stepEls.length) return;

    const setupOne = (svgSel: string, thresholds: number[]) => {
      const svg = this.host.querySelector<SVGSVGElement>(svgSel);
      const path = svg?.querySelector<SVGPathElement>('.thread-line');
      if (!svg || !path) return undefined;

      let len = 0;
      const vb = svg.viewBox.baseVal;

      const measure = () => {
        len = path.getTotalLength();
        path.style.strokeDasharray = `${len}`;
        path.style.strokeDashoffset = `${len}`;
      };
      measure();

      const place = (p: number) => {
        path.style.strokeDashoffset = `${len * (1 - p)}`;
        const pt = path.getPointAtLength(len * p);
        const svgRect = svg.getBoundingClientRect();
        const stepsRect = steps.getBoundingClientRect();
        const sx = svgRect.width / vb.width;
        const sy = svgRect.height / vb.height;
        const x = svgRect.left - stepsRect.left + pt.x * sx;
        const y = svgRect.top - stepsRect.top + pt.y * sy;
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.classList.toggle('is-on', p > 0.01 && p < 0.995);
        stepEls.forEach((el, i) => el.classList.toggle('is-lit', p >= thresholds[i]));
      };

      const st = ScrollTrigger.create({
        trigger: steps,
        start: 'top 70%',
        end: 'bottom 78%',
        scrub: 0.5,
        onRefreshInit: measure,
        onUpdate: (self) => place(self.progress),
      });
      place(st.progress);
      return st;
    };

    this.mm?.add('(min-width: 768px)', () => {
      const st = setupOne('.thread-h', [0.04, 0.38, 0.72]);
      return () => st?.kill();
    });
    this.mm?.add('(max-width: 767px)', () => {
      const st = setupOne('.thread-v', [0.06, 0.45, 0.85]);
      return () => st?.kill();
    });
  }

  /* ---------- tilt leggerissimo sulle card galleria ---------- */
  private setupTilt(): void {
    this.host.querySelectorAll<HTMLElement>('.card-tilt').forEach((card) => {
      const rx = gsap.quickTo(card, 'rotationX', { duration: 0.4, ease: 'power2.out' });
      const ry = gsap.quickTo(card, 'rotationY', { duration: 0.4, ease: 'power2.out' });
      gsap.set(card, { transformPerspective: 900 });
      card.addEventListener(
        'pointermove',
        (e) => {
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5;
          const py = (e.clientY - r.top) / r.height - 0.5;
          rx(py * -2.4);
          ry(px * 2.4);
        },
        { signal: this.ac.signal },
      );
      card.addEventListener(
        'pointerleave',
        () => {
          rx(0);
          ry(0);
        },
        { signal: this.ac.signal },
      );
    });
  }

  /* ---------- CTA magnetica (pointer fine, raggio breve) ---------- */
  private setupMagnet(): void {
    const zone = this.host.querySelector<HTMLElement>('.cta');
    const btn = this.host.querySelector<HTMLElement>('.btn-magnet');
    if (!zone || !btn) return;

    const qx = gsap.quickTo(btn, 'x', { duration: 0.35, ease: 'power2.out' });
    const qy = gsap.quickTo(btn, 'y', { duration: 0.35, ease: 'power2.out' });
    zone.addEventListener(
      'pointermove',
      (e) => {
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = Math.hypot(e.clientX - cx, e.clientY - cy);
        const reach = 150;
        if (d < reach) {
          const pull = (1 - d / reach) * 0.28;
          qx((e.clientX - cx) * pull);
          qy((e.clientY - cy) * pull);
        } else {
          qx(0);
          qy(0);
        }
      },
      { signal: this.ac.signal },
    );
    zone.addEventListener(
      'pointerleave',
      () => {
        qx(0);
        qy(0);
      },
      { signal: this.ac.signal },
    );
  }
}
