/* ============================================================================
   RePhoto — Motion engine (v2 · dependency-free · light only)
   impeccable animate: one authored moment ("Recognition"), the rest is quiet
   feedback. Arrivals use cubic-bezier(.16,1,.3,1). Exit faster than entrance.
   Compositor-safe props. Every motion has a reduced-motion path.
   Usage: <script src="../../brand/motion.js"></script> → RePhotoMotion.init()
   ============================================================================ */
(function (global) {
  "use strict";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- Press feedback on pointer-down (feedback, 130ms) ------------------ */
  function initPress(root = document) {
    root.querySelectorAll("[data-press]").forEach((el) => {
      if (el.__press) return; el.__press = true;
      const down = () => el.style.setProperty("--press", "1");
      const up = () => el.style.setProperty("--press", "0");
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointerleave", up);
      el.addEventListener("pointercancel", up);
    });
  }

  /* --- Reveal: a list appearing as a list, once, capped stagger ---------
     Use ONLY where a group genuinely appears (gallery results, a card row) —
     never one identical fade on every section. */
  function initReveal(root = document) {
    const items = root.querySelectorAll("[data-reveal]");
    if (!items.length) return;
    if (reduced || !("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("is-revealed"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const delay = Math.min(parseFloat(el.dataset.revealDelay || "0"), 420);
        el.style.transitionDelay = delay + "ms";
        el.classList.add("is-revealed");
        io.unobserve(el);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    items.forEach((el) => io.observe(el));
  }

  /* --- The authored moment: "Recognition" -------------------------------
     A scanning frame sweeps a wall of photos; matching tiles resolve from
     dimmed+slightly-scaled into focus and lift. Runs once, on load.
     Markup: [data-recognition] wraps [data-rec-tile] elements; mark matches
     with data-rec-match. A [data-rec-scan] child is the sweeping frame. */
  function initRecognition(root = document) {
    root.querySelectorAll("[data-recognition]").forEach((stage) => {
      const tiles = Array.from(stage.querySelectorAll("[data-rec-tile]"));
      const matches = tiles.filter((t) => t.hasAttribute("data-rec-match"));
      if (reduced) { stage.classList.add("rec-done"); return; }
      stage.classList.add("rec-armed");
      const start = () => {
        stage.classList.add("rec-scanning");
        // resolve matches in a short capped stagger as the scan passes
        matches.forEach((t, i) => {
          const d = 420 + Math.min(i * 90, 540);
          setTimeout(() => t.classList.add("rec-matched"), d);
        });
        setTimeout(() => { stage.classList.remove("rec-scanning"); stage.classList.add("rec-done"); }, 1500);
      };
      // begin once in view (or immediately if already visible)
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => es.forEach((e) => {
          if (e.isIntersecting) { io.disconnect(); requestAnimationFrame(() => requestAnimationFrame(start)); }
        }), { threshold: 0.4 });
        io.observe(stage);
      } else { start(); }
    });
  }

  /* --- Count-up for metrics (tabular) ------------------------------------ */
  function initCountUp(root = document) {
    const els = root.querySelectorAll("[data-countup]");
    if (!els.length) return;
    const run = (el) => {
      const end = parseFloat(el.dataset.countup);
      const dur = parseInt(el.dataset.countupDur || "900", 10);
      const suffix = el.dataset.countupSuffix || "";
      if (reduced) { el.textContent = end.toLocaleString("it-IT") + suffix; return; }
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(end * eased).toLocaleString("it-IT") + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (!("IntersectionObserver" in window)) { els.forEach(run); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { run(e.target); io.unobserve(e.target); }
    }), { threshold: 0.6 });
    els.forEach((el) => io.observe(el));
  }

  /* --- Bottom sheet / modal ---------------------------------------------- */
  function attachSheet(sheet) {
    const scrim = sheet.previousElementSibling;
    const open = () => { sheet.dataset.state = "open"; if (scrim && scrim.classList.contains("scrim")) scrim.dataset.state = "open"; };
    const close = () => { sheet.dataset.state = "closed"; if (scrim && scrim.classList.contains("scrim")) scrim.dataset.state = "closed"; };
    sheet.__open = open; sheet.__close = close;
    if (scrim && scrim.classList.contains("scrim")) scrim.addEventListener("click", close);
    sheet.querySelectorAll("[data-sheet-close],[data-close]").forEach((b) => b.addEventListener("click", close));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    return { open, close };
  }
  function initSheets(root = document) {
    root.querySelectorAll("[data-sheet],[data-modal]").forEach((s) => { if (!s.__open) attachSheet(s); });
    root.querySelectorAll("[data-sheet-open],[data-modal-open]").forEach((btn) => {
      const id = btn.dataset.sheetOpen || btn.dataset.modalOpen;
      const target = document.getElementById(id);
      if (target && target.__open) btn.addEventListener("click", target.__open);
    });
  }

  /* --- Blur-up image load (purpose: prevent jarring pop-in) --------------- */
  function initBlurUp(root = document) {
    root.querySelectorAll("img.blur-up").forEach((img) => {
      if (img.__blur) return; img.__blur = true;
      const done = () => img.classList.add("is-loaded");
      if (img.complete && img.naturalWidth > 0) requestAnimationFrame(done);
      else { img.addEventListener("load", done, { once: true }); img.addEventListener("error", done, { once: true }); }
    });
  }

  function init(root) {
    initPress(root); initReveal(root); initRecognition(root);
    initCountUp(root); initSheets(root); initBlurUp(root);
  }

  global.RePhotoMotion = { init, initPress, initReveal, initRecognition, initCountUp, initSheets, initBlurUp, reduced };
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", () => init());
})(window);
