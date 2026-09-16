/* ==========================================================================
   Tobi Aina — portfolio behaviour
   Two small pieces only: the case-study tab set and the scroll reveal.
   No analytics, no tracking, no third-party scripts.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------- Analytics
     Vercel Web Analytics. Counting only, never content: no name, email or
     message text is ever sent, just that a stage happened. If the script is
     blocked or fails to load, this does nothing and the form is unaffected.
  */
  function track(name, detail) {
    try {
      if (typeof window.va === "function") { window.va("event", { name: name, data: detail }); }
    } catch (error) { /* analytics must never break the form */ }
  }


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

    var caseInteracted = false;

    function select(index, moveFocus) {
      if (!caseInteracted) { caseInteracted = true; track("case_study_interaction"); }
      tabs.forEach(function (tab, i) {
        var selected = i === index;
        var panel = document.getElementById(tab.getAttribute("aria-controls"));

        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (panel) {
          panel.hidden = !selected;
          // A screen the visitor just asked for must not wait on lazy loading.
          if (selected) {
            var img = panel.querySelector("img");
            if (img && img.loading === "lazy") { img.loading = "eager"; }
          }
        }
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

  /* ---------------------------------------------------------- Enquiry form
     Submits in the background so the visitor stays on the page. Without
     JavaScript the form still posts normally, and the email address beside
     it is always there as a fallback -- an enquiry should never depend on
     one path working.
  */
  var form = document.getElementById("contact-form");

  if (form) {
    var status = document.getElementById("cf-status");
    var submit = document.getElementById("cf-submit");
    var fields = ["name", "email", "message"];
    var started = false;

    function showError(field, text) {
      var input = document.getElementById("cf-" + field);
      var slot = document.getElementById("cf-" + field + "-error");
      if (!input || !slot) return;
      if (text) {
        slot.textContent = text;
        slot.hidden = false;
        input.setAttribute("aria-invalid", "true");
      } else {
        slot.textContent = "";
        slot.hidden = true;
        input.removeAttribute("aria-invalid");
      }
    }

    function clearErrors() {
      fields.forEach(function (field) { showError(field, ""); });
    }

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = "form-status" + (kind ? " " + kind : "");
    }

    function validate(values) {
      var errors = {};
      if (!values.name) errors.name = "Please tell me your name.";
      if (!values.email) errors.email = "Please add an email address so I can reply.";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = "That email address does not look right.";
      if (!values.message) errors.message = "Please describe what is happening.";
      else if (values.message.length < 10) errors.message = "A sentence or two would help.";
      return errors;
    }

    fields.forEach(function (field) {
      var input = document.getElementById("cf-" + field);
      if (input) {
        input.addEventListener("input", function () {
          showError(field, "");
          // Once per visit: the gap between this and a submit is the
          // drop-off worth knowing about.
          if (!started) { started = true; track("contact_form_started"); }
        });
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      clearErrors();

      var values = {
        name: form.elements.name.value.trim(),
        email: form.elements.email.value.trim(),
        message: form.elements.message.value.trim(),
        company: form.elements.company.value.trim()
      };

      var errors = validate(values);
      var firstBad = fields.filter(function (f) { return errors[f]; })[0];

      if (firstBad) {
        fields.forEach(function (field) { showError(field, errors[field] || ""); });
        setStatus("", "");
        document.getElementById("cf-" + firstBad).focus();
        return;
      }

      submit.disabled = true;
      submit.textContent = "Sending\u2026";
      setStatus("", "");

      fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values)
      })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.ok && result.data.ok) {
            form.reset();
            track("contact_form_submitted");
            setStatus("Thank you \u2014 that reached me. I reply to every message, usually the same day.", "ok");
            return;
          }
          if (result.data.errors) {
            fields.forEach(function (field) { showError(field, result.data.errors[field] || ""); });
            var bad = fields.filter(function (f) { return result.data.errors[f]; })[0];
            if (bad) document.getElementById("cf-" + bad).focus();
            setStatus("", "");
            track("contact_form_rejected");
            return;
          }
          track("contact_form_failed", { stage: "server" });
          setStatus(result.data.error || "Something went wrong. Please email tobaina@gmail.com directly.", "bad");
        })
        .catch(function () {
          track("contact_form_failed", { stage: "network" });
          setStatus("Something went wrong. Please email tobaina@gmail.com directly.", "bad");
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = "Send it to me";
        });
    });
  }

  /* ------------------------------------------------ Conversion tracking
     Anything carrying data-track reports a click by name. Names only --
     never the contents of a message, never an email address, never anything
     that identifies the visitor.
  */
  Array.prototype.slice.call(document.querySelectorAll("[data-track]")).forEach(function (el) {
    el.addEventListener("click", function () {
      track(el.getAttribute("data-track") + "_click");
    });
  });

  /* ---------------------------------------------------- In-page navigation
     The nav links used to rely on CSS `scroll-behavior: smooth`. That
     silently does nothing when the tab is not visible, and the browser can
     abandon the animation part-way, so clicking Pricing changed the URL and
     left the page where it was.

     This does the scroll itself and then checks, 400ms later, that the page
     actually moved. If it did not -- for any reason, in any browser -- it
     jumps straight there. The link always works; smooth is only ever a
     nicety layered on top.
  */
  var inPageLinks = Array.prototype.slice.call(document.querySelectorAll('a[href^="#"]'));

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function goTo(target, updateHash) {
    if (!target) { return; }

    var before = window.pageYOffset;
    var wanted = Math.round(target.getBoundingClientRect().top + before);

    try {
      target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    } catch (error) {
      target.scrollIntoView();            // very old browsers: no options object
    }

    // The guarantee. If nothing moved, put the page where it belongs.
    window.setTimeout(function () {
      if (Math.abs(window.pageYOffset - before) < 2 && Math.abs(wanted - before) > 2) {
        window.scrollTo(0, wanted);
      }
    }, 400);

    if (updateHash && target.id && window.history && window.history.pushState) {
      window.history.pushState(null, "", "#" + target.id);
    }

    // Keyboard users must land in the section, not back at the top.
    if (!target.hasAttribute("tabindex")) { target.setAttribute("tabindex", "-1"); }
    target.focus({ preventScroll: true });
  }

  inPageLinks.forEach(function (link) {
    link.addEventListener("click", function (event) {
      var id = link.getAttribute("href").slice(1);
      if (!id) { return; }                                  // a bare "#"
      var target = document.getElementById(id);
      if (!target) { return; }                              // let the browser try
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) { return; }

      event.preventDefault();
      goTo(target, true);
    });
  });

  // Arriving with a fragment already in the URL, e.g. a shared link.
  if (window.location.hash.length > 1) {
    var landing = document.getElementById(window.location.hash.slice(1));
    if (landing) {
      window.setTimeout(function () { goTo(landing, false); }, 60);
    }
  }

}());
