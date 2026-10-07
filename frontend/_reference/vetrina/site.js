/* ============================================================================
   Frames of Me — Vetrina shared behaviour (dependency-free, light only)
   Quiet, functional feedback only (motion plan §4): mobile nav toggle,
   language switcher (visual stub — content stays Italian), newsletter submit.
   Accordions use native <details>/<summary>; no JS needed for them.
   Load after motion.js: <script src="site.js"></script>
   ============================================================================ */
(function () {
  "use strict";

  /* --- Mobile nav toggle ------------------------------------------------- */
  function initNav() {
    var toggle = document.querySelector("[data-nav-toggle]");
    var nav = document.getElementById("siteNav");
    if (!toggle || !nav) return;
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      nav.dataset.open = String(open);
    };
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    // reset when leaving the mobile breakpoint
    window.matchMedia("(min-width: 921px)").addEventListener("change", function (m) {
      if (m.matches) setOpen(false);
    });
  }

  /* --- Language switcher (RO · IT · EN) — visual stub -------------------- */
  function initLang() {
    var groups = document.querySelectorAll(".lang-switch");
    if (!groups.length) return;
    var stored = null;
    try { stored = localStorage.getItem("rephoto-lang"); } catch (e) {}
    groups.forEach(function (group) {
      var buttons = group.querySelectorAll("button[data-lang]");
      var apply = function (lang) {
        buttons.forEach(function (b) {
          var on = b.dataset.lang === lang;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", String(on));
        });
      };
      if (stored) apply(stored);
      buttons.forEach(function (b) {
        b.addEventListener("click", function () {
          var lang = b.dataset.lang;
          try { localStorage.setItem("rephoto-lang", lang); } catch (e) {}
          document.querySelectorAll(".lang-switch").forEach(function (g) {
            g.querySelectorAll("button[data-lang]").forEach(function (x) {
              var on = x.dataset.lang === lang;
              x.classList.toggle("is-active", on);
              x.setAttribute("aria-pressed", String(on));
            });
          });
          // Visual stub: content remains Italian in this prototype.
        });
      });
    });
  }

  /* --- Newsletter submit (inline confirmation, no navigation) ------------ */
  function initNewsletter() {
    document.querySelectorAll("[data-newsletter]").forEach(function (form) {
      var note = form.querySelector(".form-note");
      var consent = form.querySelector("input[type=checkbox]");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (consent && !consent.checked) {
          consent.focus();
          return;
        }
        form.querySelectorAll(".input, .btn, .check").forEach(function (el) {
          el.setAttribute("hidden", "");
        });
        if (note) {
          note.classList.add("is-visible");
          note.setAttribute("role", "status");
        }
      });
    });
  }

  function start() { initNav(); initLang(); initNewsletter(); }
  if (document.readyState !== "loading") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
