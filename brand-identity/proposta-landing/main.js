/* ============================================================
   Frames of Me — proposta landing: regia del movimento.
   - GSAP + ScrollTrigger (cdnjs) SOLO per lo scroll-driven:
     hero "momento del match" e filo dei tre gesti.
   - Tutto il resto è vanilla: reveal (IntersectionObserver),
     count-up, tilt, bottone magnetico, pecorella inline.
   - Degrado: senza GSAP o con prefers-reduced-motion la pagina
     è statica negli stati finali (il CSS è la verità).
   ============================================================ */
(() => {
  "use strict";

  const html = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const hasGsap = typeof gsap !== "undefined" && typeof ScrollTrigger !== "undefined";
  const anim = !reduce && hasGsap;

  html.classList.add("js-reveal");
  if (anim) {
    html.classList.add("js-anim");
    gsap.registerPlugin(ScrollTrigger);
  }

  /* ---------- pecorella: l'SVG va inline perché il suo CSS
     anima i gruppi interni (#corpo, #testa, zampe...) ---------- */
  const sheep = document.getElementById("pecorella-footer");
  if (sheep) {
    fetch("../pecorella/mascot/pecorella.svg")
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((svg) => { sheep.innerHTML = svg; })
      .catch(() => { sheep.remove(); });
  }

  /* ---------- reveal: entra una volta, ease-out 480ms ---------- */
  const revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.18, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* ---------- numeri che contano (tabulari, it-IT) ----------
     Raggruppamento manuale: l'italiano CLDR non separa i numeri
     a 4 cifre («6000»), ma la pagina scrive «6.000». */
  const fmt = {
    format: (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "."),
  };
  const counters = document.querySelectorAll("[data-count]");
  if (counters.length) {
    const run = (el) => {
      const end = parseInt(el.dataset.count, 10);
      if (reduce || !("requestAnimationFrame" in window)) {
        el.textContent = fmt.format(end);
        return;
      }
      const t0 = performance.now();
      const dur = 900;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3); /* ease-out cubico */
        el.textContent = fmt.format(Math.round(end * eased));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            run(e.target);
            io.unobserve(e.target);
          }
        }
      }, { threshold: 0.6 });
      counters.forEach((el) => io.observe(el));
    } else {
      counters.forEach((el) => { el.textContent = fmt.format(+el.dataset.count); });
    }
  }

  /* ============================================================
     HERO — il momento del match (scrub).
     Il mirino viaggia tra i volti, si aggancia, e quattro scatti
     volano nella pila personale con la chip «47 foto con te».
     Waypoint in frazioni della foto (misurati su event-01).
     ============================================================ */
  if (anim) {
    try {
      const stage = document.querySelector(".stage");
      const photo = document.querySelector(".stage-photo > img");
      const vf = document.querySelector(".vf");
      const sky = document.querySelector(".vf-layer-sky");
      const act = document.querySelector(".vf-layer-action");
      const ring = document.querySelector(".vf-ring");
      const vfChip = document.querySelector(".vf-chip");
      const minis = gsap.utils.toArray(".mini");
      const stackChip = document.querySelector(".stack-chip");

      /* target del mirino (CSS): left 60% / top 47% della foto */
      const TARGET = { x: 0.60, y: 0.49 };
      const WAYPOINTS = [{ x: 0.28, y: 0.19 }, { x: 0.84, y: 0.385 }];
      const dx = (p) => () => (p.x - TARGET.x) * photo.clientWidth;
      const dy = (p) => () => (p.y - TARGET.y) * photo.clientHeight;

      /* delta pila → centro foto (le mini partono "dal match") */
      const fromX = (i, el) => {
        const a = photo.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return (a.left + a.width * TARGET.x) - (b.left + b.width / 2);
      };
      const fromY = (i, el) => {
        const a = photo.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return (a.top + a.height * TARGET.y) - (b.top + b.height / 2);
      };

      const buildTimeline = (st) => {
        const tl = gsap.timeline({ scrollTrigger: st, defaults: { ease: "none" } });

        /* 1. il mirino cerca: viaggia tra i volti */
        tl.fromTo(vf,
          { x: dx(WAYPOINTS[0]), y: dy(WAYPOINTS[0]), scale: 1.14 },
          { x: dx(WAYPOINTS[1]), y: dy(WAYPOINTS[1]), scale: 1.05, duration: 1 }, 0)
          .to(vf, { x: 0, y: 0, scale: 1, duration: 1 }, 1);

        /* 2. aggancio: crossfade cielo→azione, impulso, «Sei tu» */
        tl.to(sky, { opacity: 0, duration: 0.12 }, 2)
          .to(act, { opacity: 1, duration: 0.12 }, 2)
          .to(vf, { scale: 0.92, duration: 0.18, ease: "power1.out" }, 2)
          .fromTo(ring, { opacity: 0.85, scale: 0.88 },
                        { opacity: 0, scale: 1.16, duration: 0.4, ease: "power1.out" }, 2)
          .fromTo(vfChip, { autoAlpha: 0, y: -6 },
                          { autoAlpha: 1, y: 0, duration: 0.25, ease: "power1.out" }, 2.1);

        /* 3. gli scatti volano nella pila personale
           (set iniziale esplicito: il CSS li pre-nasconde) */
        const ROTS = [-6, 4, -2, 2.5];
        gsap.set(minis, { x: fromX, y: fromY, rotation: 0, scale: 0.5, autoAlpha: 0 });
        tl.to(minis, {
          x: 0, y: 0,
          rotation: (i) => ROTS[i], scale: 1, autoAlpha: 1,
          duration: 0.75, stagger: 0.22, ease: "power1.inOut",
        }, 2.45)
          .fromTo(stackChip, { autoAlpha: 0, scale: 0.94, y: 8 },
                             { autoAlpha: 1, scale: 1, y: 0, duration: 0.3, ease: "power1.out" }, 3.75);

        return tl;
      };

      const mm = gsap.matchMedia();
      mm.add("(min-width: 920px)", () => {
        buildTimeline({
          trigger: ".hero",
          start: "top 64px",
          end: "+=110%",
          pin: true,
          anticipatePin: 1,
          scrub: 0.5,
          invalidateOnRefresh: true,
        });
      });
      mm.add("(max-width: 919px)", () => {
        buildTimeline({
          trigger: stage,
          start: "top 88%",
          end: "top 28%",
          scrub: 0.6,
          invalidateOnRefresh: true,
        });
      });
    } catch (e) {
      html.classList.add("hero-fallback");
    }
  }

  /* ============================================================
     TRE GESTI — il filo si disegna allo scroll e porta un
     pallino che accende i numeri al passaggio.
     ============================================================ */
  if (anim) {
    const steps = document.querySelector(".steps");
    const dot = document.querySelector(".thread-dot");
    const stepEls = gsap.utils.toArray("[data-step]");

    const setupThread = (svgSel, thresholds) => {
      const svg = document.querySelector(svgSel);
      const path = svg && svg.querySelector(".thread-line");
      if (!svg || !path) return;

      let len = 0;
      const vb = svg.viewBox.baseVal;

      const measure = () => {
        len = path.getTotalLength();
        path.style.strokeDasharray = `${len}`;
        path.style.strokeDashoffset = `${len}`;
      };
      measure();

      const place = (p) => {
        path.style.strokeDashoffset = `${len * (1 - p)}`;
        const pt = path.getPointAtLength(len * p);
        const sx = svg.clientWidth / vb.width;
        const sy = svg.clientHeight / vb.height;
        const x = svg.offsetLeft + pt.x * sx;
        const y = svg.offsetTop + pt.y * sy;
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.classList.toggle("is-on", p > 0.01 && p < 0.995);
        stepEls.forEach((el, i) => el.classList.toggle("is-lit", p >= thresholds[i]));
      };

      const st = ScrollTrigger.create({
        trigger: steps,
        start: "top 70%",
        end: "bottom 78%",
        scrub: 0.5,
        onRefreshInit: measure,
        onUpdate: (self) => place(self.progress),
      });
      place(st.progress);
      return st;
    };

    const mm = gsap.matchMedia();
    mm.add("(min-width: 768px)", () => {
      const st = setupThread(".thread-h", [0.04, 0.38, 0.72]);
      return () => st && st.kill();
    });
    mm.add("(max-width: 767px)", () => {
      const st = setupThread(".thread-v", [0.06, 0.45, 0.85]);
      return () => st && st.kill();
    });
  }

  /* ---------- tilt leggerissimo sulle card galleria ---------- */
  if (anim && fine) {
    document.querySelectorAll(".card-tilt").forEach((card) => {
      const rx = gsap.quickTo(card, "rotationX", { duration: 0.4, ease: "power2.out" });
      const ry = gsap.quickTo(card, "rotationY", { duration: 0.4, ease: "power2.out" });
      gsap.set(card, { transformPerspective: 900 });
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        rx(py * -2.4);
        ry(px * 2.4);
      });
      card.addEventListener("pointerleave", () => { rx(0); ry(0); });
    });
  }

  /* ---------- CTA magnetica (pointer fine, raggio breve) ---------- */
  if (anim && fine) {
    const zone = document.querySelector(".cta");
    const btn = document.querySelector(".btn-magnet");
    if (zone && btn) {
      const qx = gsap.quickTo(btn, "x", { duration: 0.35, ease: "power2.out" });
      const qy = gsap.quickTo(btn, "y", { duration: 0.35, ease: "power2.out" });
      zone.addEventListener("pointermove", (e) => {
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
          qx(0); qy(0);
        }
      });
      zone.addEventListener("pointerleave", () => { qx(0); qy(0); });
    }
  }
})();
