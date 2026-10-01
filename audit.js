/* ==========================================================================
   Workflow Audit — the stepped flow, the result, and the capture.

   Reads its questions from audit-score.js so there is exactly one place the
   wording and the arithmetic live. If you add a question, add it there.
   ========================================================================== */
(function () {
  "use strict";
  var A = window.PolishaAudit;
  if (!A) return;

  var Q = A.QUESTIONS;
  var answers = {};
  var step = 0;

  var el = function (id) { return document.getElementById(id); };
  var intro = el("audit-intro"), quiz = el("audit-quiz"), result = el("audit-result");
  var optionsBox = el("audit-options"), errorBox = el("audit-error");
  var track = function (name, props) {
    try { if (window.va) window.va("event", { name: name, data: props || {} }); } catch (e) {}
  };

  /* ---------------------------------------------------------- rendering */
  function renderStep() {
    var q = Q[step];
    el("audit-section").textContent = q.section;
    el("audit-q-text").textContent = q.text;
    var hint = el("audit-hint");
    if (q.hint) { hint.textContent = q.hint; hint.hidden = false; } else { hint.hidden = true; }
    el("audit-count").textContent = "Question " + (step + 1) + " of " + Q.length;
    el("audit-bar-fill").style.width = Math.round(((step) / Q.length) * 100) + "%";
    el("audit-back").disabled = step === 0;
    el("audit-next").innerHTML = step === Q.length - 1
      ? 'See my result <span class="arrow" aria-hidden="true">&rarr;</span>'
      : 'Next <span class="arrow" aria-hidden="true">&rarr;</span>';
    errorBox.hidden = true;

    optionsBox.innerHTML = "";
    var picked = answers[q.id];
    q.options.forEach(function (o, i) {
      var id = "opt-" + q.id + "-" + o.value;
      var wrap = document.createElement("label");
      wrap.className = "audit-option";
      wrap.setAttribute("for", id);

      var input = document.createElement("input");
      input.type = q.multi ? "checkbox" : "radio";
      input.name = q.id;
      input.value = o.value;
      input.id = id;
      if (q.multi) input.checked = Array.isArray(picked) && picked.indexOf(o.value) > -1;
      else input.checked = picked === o.value;

      var text = document.createElement("span");
      text.textContent = o.label;

      wrap.appendChild(input);
      wrap.appendChild(text);
      optionsBox.appendChild(wrap);

      /* A single-choice answer moves on by itself, which is what makes twelve
         questions feel like six minutes. A multi-choice one cannot, because
         the visitor has not finished choosing. */
      input.addEventListener("change", function () {
        /* "None of these" and a real choice cannot both be true. Picking one
           clears the other, so the answer that reaches the scorer is never
           self-contradictory. */
        if (q.multi && input.checked) {
          var all = optionsBox.querySelectorAll("input");
          if (o.exclusive) {
            Array.prototype.forEach.call(all, function (nd) {
              if (nd !== input) nd.checked = false;
            });
          } else {
            q.options.forEach(function (other, j) {
              if (other.exclusive) all[j].checked = false;
            });
          }
        }
        record(q);
        errorBox.hidden = true;
        if (!q.multi) window.setTimeout(next, 180);
      });
      if (i === 0) window.setTimeout(function () { input.focus(); }, 30);
    });
  }

  function record(q) {
    var nodes = optionsBox.querySelectorAll("input");
    if (q.multi) {
      var list = [];
      Array.prototype.forEach.call(nodes, function (nd) { if (nd.checked) list.push(nd.value); });
      answers[q.id] = list;
    } else {
      Array.prototype.forEach.call(nodes, function (nd) { if (nd.checked) answers[q.id] = nd.value; });
    }
  }

  function answered(q) {
    var a = answers[q.id];
    return q.multi ? Array.isArray(a) && a.length > 0 : !!a;
  }

  function next() {
    var q = Q[step];
    record(q);
    if (!answered(q)) { errorBox.hidden = false; return; }
    if (step === Q.length - 1) { finish(); return; }
    step += 1;
    renderStep();
  }

  function back() {
    if (step === 0) return;
    step -= 1;
    renderStep();
  }

  /* ------------------------------------------------------------- result */
  var lastResult = null;

  function finish() {
    var r = A.score(answers);
    lastResult = r;
    el("audit-bar-fill").style.width = "100%";

    el("audit-hours").textContent = r.hours;
    el("audit-result-lead").textContent = r.hours > 0
      ? "That is time going into work a system could take off you, worked out from what you told us."
      : "On your answers there is almost nothing here that a system would take off you, which is a good position to be in.";

    var tbody = el("audit-parts");
    tbody.innerHTML = "";
    r.parts.forEach(function (p) {
      var tr = document.createElement("tr");
      var th = document.createElement("th");
      th.scope = "row"; th.textContent = p.label;
      var td1 = document.createElement("td"); td1.textContent = p.working;
      var td2 = document.createElement("td"); td2.className = "audit-h"; td2.textContent = p.hours + "h";
      tr.appendChild(th); tr.appendChild(td1); tr.appendChild(td2);
      tbody.appendChild(tr);
    });

    /* The cap is explained to the visitor, not quietly applied. */
    var capped = el("audit-capped");
    if (r.cappedByOwnEstimate) {
      capped.textContent = "Those answers add up to " + r.rawHours + " hours, but you told us the whole team spends about " +
        r.capHours + " hours a week on admin, so we have used the smaller figure. We would rather be under than over.";
      capped.hidden = false;
    } else { capped.hidden = true; }

    fill("audit-stalls", r.stalls, "li");
    el("audit-stalls-col").hidden = r.stalls.length === 0;

    var opps = el("audit-opps");
    opps.innerHTML = "";
    r.opportunities.forEach(function (o) {
      var li = document.createElement("li");
      var b = document.createElement("b"); b.textContent = o.fix;
      var s = document.createElement("span"); s.textContent = " about " + o.hours + "h a week, from " + o.because;
      li.appendChild(b); li.appendChild(s);
      opps.appendChild(li);
    });
    el("audit-opps-col").hidden = r.opportunities.length === 0;

    el("audit-verdict-head").textContent = r.verdict.headline;
    el("audit-verdict-body").textContent = r.verdict.body;
    var acts = el("audit-verdict-actions");
    acts.innerHTML = "";
    if (r.verdict.cta === "diagnostic") {
      acts.appendChild(link("/#diagnostic", "Book the diagnostic", "primary", "audit_to_diagnostic"));
      acts.appendChild(link("/#contact", "Or just tell us about it", "secondary", "audit_to_contact"));
    } else if (r.verdict.cta === "check") {
      acts.appendChild(link("/#contact", "Book the free process check", "primary", "audit_to_check"));
    }

    quiz.hidden = true;
    result.hidden = false;
    result.focus();
    track("audit_completed", { hours: r.hours, verdict: r.verdict.key });
  }

  function fill(id, items, tag) {
    var box = el(id);
    box.innerHTML = "";
    items.forEach(function (t) {
      var node = document.createElement(tag);
      node.textContent = t;
      box.appendChild(node);
    });
  }

  function link(href, label, kind, trackName) {
    var a = document.createElement("a");
    a.className = "button " + kind;
    a.href = href;
    a.textContent = label;
    a.setAttribute("data-track", trackName);
    return a;
  }

  /* ------------------------------------------------------------ capture */
  function sendCapture(ev) {
    ev.preventDefault();
    var form = el("audit-capture-form");
    var status = el("au-status");
    var btn = el("au-submit");
    var name = el("au-name").value.trim();
    var email = el("au-email").value.trim();

    var ok = true;
    ok = setError("au-name", name ? "" : "Please tell us your name.") && ok;
    ok = setError("au-email", /.+@.+\..+/.test(email) ? "" : "Please add an email address we can reply to.") && ok;
    if (!ok) return;

    btn.disabled = true;
    status.textContent = "Sending…";

    fetch(form.getAttribute("action"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name,
        email: email,
        website: el("au-website").value,
        subscribe: el("au-subscribe").checked === true,
        answers: answers,
        hours: lastResult ? lastResult.hours : 0,
        verdict: lastResult ? lastResult.verdict.key : "",
      }),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok) {
          status.textContent = "Sent. Check your inbox in a minute or two.";
          form.querySelectorAll("input").forEach(function (i) { i.disabled = true; });
          track("audit_capture_sent", { verdict: lastResult ? lastResult.verdict.key : "" });
        } else {
          btn.disabled = false;
          status.textContent = "That did not send. Please reach us through the LinkedIn link on the main site.";
        }
      })
      .catch(function () {
        btn.disabled = false;
        status.textContent = "That did not send. Please reach us through the LinkedIn link on the main site.";
      });
  }

  function setError(id, msg) {
    var field = el(id), box = el(id + "-error");
    if (!box) return !msg;
    box.textContent = msg;
    box.hidden = !msg;
    field.setAttribute("aria-invalid", msg ? "true" : "false");
    return !msg;
  }

  /* --------------------------------------------------------------- wire */
  el("audit-start").addEventListener("click", function () {
    intro.hidden = true;
    quiz.hidden = false;
    step = 0;
    renderStep();
    track("audit_started");
  });
  el("audit-form").addEventListener("submit", function (e) { e.preventDefault(); next(); });
  el("audit-back").addEventListener("click", back);
  el("audit-capture-form").addEventListener("submit", sendCapture);
  el("audit-restart").addEventListener("click", function () {
    answers = {}; step = 0; lastResult = null;
    result.hidden = true; intro.hidden = false;
    el("audit-start").focus();
  });
})();
