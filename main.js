/* ==========================================================================
   Tobi Aina — portfolio behaviour
   Two small pieces only: the case-study tab set and the scroll reveal.
   No analytics, no tracking, no third-party scripts.
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- Tabs
     A proper ARIA tab set: one stop in the tab order (roving tabindex),
     arrow / Home / End keys move between tabs, and the selected tab, the
     visible screenshot and the caption always change together.
  */
  var tablist = document.querySelector('[role="tablist"]');
  var caption = document.getElementById("gallery-caption");

  if (tablist && caption) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));

    var captions = {
      "tab-capacity":  "approved workload and available client slots, enforced by the database.",
      "tab-approvals": "the controlled path for requesting and recording capacity changes.",
      "tab-quality":   "quality results and the exact rule version used at the time.",
      "tab-overview":  "clients, workload and operational warnings in one view."
    };

    function select(index, moveFocus) {
      tabs.forEach(function (tab, i) {
        var selected = i === index;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));

        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (panel) { panel.hidden = !selected; }
      });

      var current = tabs[index];
      caption.textContent = "";
      var label = document.createElement("b");
      label.textContent = current.textContent + ":";
      caption.appendChild(label);
      caption.appendChild(
        document.createTextNode(" " + (captions[current.id] || ""))
      );

      if (moveFocus) { current.focus(); }
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () { select(index, false); });

      tab.addEventListener("keydown", function (event) {
        var next = null;
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown": next = (index + 1) % tabs.length; break;
          case "ArrowLeft":
          case "ArrowUp":   next = (index - 1 + tabs.length) % tabs.length; break;
          case "Home":      next = 0; break;
          case "End":       next = tabs.length - 1; break;
          default: return;
        }
        event.preventDefault();
        select(next, true);
      });
    });
  }

  /* -------------------------------------------------------------- Reveal
     Progressive enhancement. The CSS hides .reveal blocks; if this script
     is blocked or IntersectionObserver is missing, everything is shown
     immediately instead of staying invisible.
  */
  var revealables = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!revealables.length) { return; }

  if (reduced || typeof IntersectionObserver === "undefined") {
    revealables.forEach(function (element) { element.classList.add("visible"); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  revealables.forEach(function (element) { observer.observe(element); });
}());
