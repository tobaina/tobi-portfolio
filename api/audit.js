/* ==========================================================================
   /api/audit — the Workflow Audit capture.

   Two things happen here and both matter:
     1. The visitor is sent their OWN result, because the form promises it.
        If this ever stops working, the page is asking for an address in
        exchange for something it does not deliver, and the button must be
        changed the same day.
     2. We get a scored lead, with the hours figure and the verdict, so an
        enquiry can be read in ten seconds rather than opened and decoded.

   ⚠️  THE ANSWERS ARE RE-SCORED HERE AND THE CLIENT'S NUMBER IS NOT TRUSTED.
   The browser posts what it worked out, but anybody can post anything. The
   notification uses the figure this file computes from the submitted answers,
   and flags a mismatch rather than silently preferring one. A lead that says
   "16 hours" has to mean the answers add up to 16 hours.

   ⚠️  EVERY ANSWER IS ALLOWLISTED THROUGH audit-score.js.
   Nothing a visitor types reaches an inbox as a label. Same rule as the
   `need` and `budget` dropdowns in contact.js, for the same reason.
   ========================================================================== */
const path = require("path");
const audit = require(path.join(__dirname, "..", "audit-score.js"));
const { addToMarketingList } = require("./_marketing.js");
const { senderFrom } = require("./_sender.js");

/* ⚠️  THE LEAD NOTIFICATION GOES TO THE BUSINESS MAILBOX, NOT A PERSON.
   This is the audit's only purpose: the visitor's own copy is the product,
   this is the enquiry. It sat on a personal Gmail alongside contact.js, and
   both moved the day getpolisha.com got mail. Keep the two the same: a lead
   that arrives in one inbox and not the other is a lead someone loses. */
const TO = "hello@getpolisha.com";
const LIMITS = { name: 100, email: 254 };

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;
const recent = new Map();

function rateLimited(ip) {
  const now = Date.now();
  for (const [key, stamps] of recent) {
    const live = stamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) recent.set(key, live);
    else recent.delete(key);
  }
  const mine = recent.get(ip) || [];
  if (mine.length >= RATE_MAX) return true;
  mine.push(now);
  recent.set(ip, mine);
  return false;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function readBody(req) {
  const raw = req.body;
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return typeof raw === "object" ? raw : {};
}

/* Only values the audit itself defines survive. Anything else is dropped,
   not coerced, so an unknown option can never become a line in an email. */
function sanitiseAnswers(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  audit.QUESTIONS.forEach((q) => {
    const given = input[q.id];
    const allowed = q.options.map((o) => o.value);
    if (q.multi) {
      if (!Array.isArray(given)) return;
      const kept = given.filter((v) => allowed.indexOf(v) > -1);
      if (kept.length) out[q.id] = kept;
    } else if (typeof given === "string" && allowed.indexOf(given) > -1) {
      out[q.id] = given;
    }
  });
  return out;
}

function plainResult(result, answers) {
  const lines = [];
  lines.push("About " + result.hours + " hours a week.");
  if (result.cappedByOwnEstimate) {
    lines.push("(Your answers add up to " + result.rawHours +
      "h, but you said the team spends about " + result.capHours +
      "h a week on admin, so we used the smaller figure.)");
  }
  lines.push("");
  lines.push("WHERE THAT COMES FROM");
  result.parts.forEach((p) => {
    lines.push("  " + p.label + ": " + p.hours + "h  (" + p.working + ")");
  });
  if (result.stalls.length) {
    lines.push("");
    lines.push("WHERE YOUR PROCESS STALLS");
    result.stalls.forEach((s) => lines.push("  - " + s));
  }
  if (result.opportunities.length) {
    lines.push("");
    lines.push("WHAT WE WOULD LOOK AT FIRST");
    result.opportunities.forEach((o, i) => {
      lines.push("  " + (i + 1) + ". " + o.fix + " — about " + o.hours + "h a week");
    });
  }
  lines.push("");
  lines.push(result.verdict.headline.toUpperCase());
  lines.push(result.verdict.body);
  lines.push("");
  lines.push("Answered " + result.answered + " of " + result.total + " questions.");
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = readBody(req);

  // Same trap as the contact form: a named field no human sees.
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const name = clean(body.name, LIMITS.name);
  const email = clean(body.email, LIMITS.email);
  const subscribe = body.subscribe === true;
  const answers = sanitiseAnswers(body.answers);

  const errors = {};
  if (!name) errors.name = "Please tell us your name.";
  if (!email) errors.email = "Please add an email address so we can send it.";
  else if (!looksLikeEmail(email)) errors.email = "That email address does not look right.";
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Please wait a moment and try again." });
  }

  // Scored here, from the submitted answers. The client's figure is only
  // compared, never used.
  const result = audit.score(answers);
  const claimed = typeof body.hours === "number" ? body.hours : null;
  const mismatch = claimed !== null && Math.abs(claimed - result.hours) > 0.6;

  const key = process.env.RESEND_API_KEY;
  /* The address comes from the environment, the name never does. See
     api/_sender.js for why. */
  const from = senderFrom(process.env.EMAIL_FROM);
  if (!key || !from) {
    console.error("[audit] Missing RESEND_API_KEY or EMAIL_FROM.");
    return res.status(500).json({ ok: false, error: "Could not send just now." });
  }

  const summary = plainResult(result, answers);

  const lead =
    "Workflow audit completed\n\n" +
    "Name:    " + name + "\n" +
    "Email:   " + email + "\n" +
    "Hours:   " + result.hours + "\n" +
    "Verdict: " + result.verdict.key + "\n" +
    "Team:    " + (result.team || "Not stated") + "\n" +
    "List:    " + (subscribe ? "requested" : "not requested") + "\n" +
    (mismatch ? "⚠ Client reported " + claimed + "h; recomputed " + result.hours + "h.\n" : "") +
    "\n" + summary + "\n\n" +
    "Raw answers: " + JSON.stringify(answers) + "\n";

  try {
    // The visitor's copy first: it is the thing the button promised.
    const toVisitor = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from,
        to: [email],
        reply_to: TO,
        subject: "Your workflow audit: about " + result.hours + " hours a week",
        text: "Hi " + name + ",\n\nHere is the result you just worked through.\n\n" +
          summary + "\n\nIf you want this checked against what actually happens rather than a " +
          "questionnaire, that is what the Operations Diagnostic does: " +
          "https://systems.getpolisha.com/#diagnostic\n\nPolisha Systems\n",
      }),
    });
    if (!toVisitor.ok) {
      const detail = await toVisitor.text().catch(() => "");
      console.error("[audit] Visitor copy failed:", toVisitor.status, detail.slice(0, 300));
      return res.status(502).json({ ok: false, error: "Could not send just now." });
    }

    // Then our own notification. A failure here must not tell the visitor
    // their copy did not arrive, because it did.
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: from,
          to: [TO],
          reply_to: email,
          subject: "Audit lead: " + result.hours + "h, " + result.verdict.key + " (" + name + ")",
          text: lead,
        }),
      });
    } catch (error) {
      console.error("[audit] Lead notification failed:", error && error.message);
    }

    const listOutcome = subscribe ? await addToMarketingList(email, key, "audit") : "not_requested";
    return res.status(200).json({ ok: true, hours: result.hours, list: listOutcome });
  } catch (error) {
    console.error("[audit] Could not reach Resend:", error && error.message);
    return res.status(502).json({ ok: false, error: "Could not send just now." });
  }
};
