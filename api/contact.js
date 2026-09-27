/* ==========================================================================
   POST /api/contact — the enquiry form's endpoint.

   Why this exists: every call to action on this site used to be a mailto:
   link. On a phone that often opens nothing at all, and the enquiry is lost
   silently. This turns an enquiry into an email that actually arrives.

   No dependencies. Resend is called over plain HTTPS with the global fetch
   built into the Node runtime, so this stays a zero-install static project.

   Two environment variables, both already set on the polisha project:
     RESEND_API_KEY  the Resend key
     EMAIL_FROM      a verified sender, e.g. "Polisha <noreply@yourdomain>"
   Neither is ever sent to the browser.
   ========================================================================== */

const TO = "tobaina@gmail.com";

/* --------------------------------------------------------------------------
   ONE LIST, NOT THREE

   getpolisha.com already keeps its marketing list as a Resend segment
   (src/lib/email.ts, addToMarketingAudience). Before this, an address that
   arrived through this form went nowhere but an inbox, so the same person
   could be a "contact" here and a "subscriber" there with no single place to
   mail from. Ticking the box on this form now writes into that same segment.

   WHY RESEND AND NOT A LIST OF OUR OWN: the promise beside the box is
   "unsubscribe any time", and keeping it needs somewhere durable to record
   that someone left. This is a static site with no database. A Resend
   segment is that store: broadcasts sent to it carry a working unsubscribe
   link and the List-Unsubscribe header Gmail and Apple Mail act on, and the
   suppression outlives any deploy.

   ⚠️  UNREACHABLE WITHOUT A DELIBERATE TICK. `unsubscribed: false` records
   the consent just given, which does resubscribe someone who previously left
   and has now opted in again — right, but only because getting here requires
   the box. If a caller ever appears that does not require one, this line
   quietly becomes a way of undoing people's unsubscribes.

   Uses RESEND_SEGMENT_ID, the same variable getpolisha reads. If it is not
   set on this project the enquiry still works and this is skipped with a log
   line — a missing list must never cost someone their message.
   -------------------------------------------------------------------------- */
async function addToMarketingList(email, key) {
  const segmentId = process.env.RESEND_SEGMENT_ID;
  if (!segmentId) {
    console.info("[contact] RESEND_SEGMENT_ID is unset; opted-in address not stored.");
    return "no_segment";
  }
  try {
    const res = await fetch("https://api.resend.com/contacts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: email, unsubscribed: false, segments: [segmentId] }),
    });
    if (!res.ok) {
      console.error("[contact] Resend rejected contact:", res.status);
      return "http_" + res.status;
    }
    return "added";
  } catch (error) {
    console.error("[contact] Could not reach Resend for the list:", error && error.message);
    return "fetch_threw";
  }
}

const LIMITS = { name: 100, email: 254, message: 5000 };
const MIN_MESSAGE = 10;

// Best-effort throttle. Serverless instances are recycled, so this is a
// speed bump for casual abuse, not a security control.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;
const recent = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 500) {
    for (const [key, times] of recent) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) recent.delete(key);
    }
  }
  return hits.length > RATE_MAX;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const body = readBody(req);

  // Honeypot. A real person never sees this field, so anything in it is a
  // bot. Answer as if it worked -- telling a bot it failed only teaches it
  // to try again.
  if (clean(body.company, 200)) {
    return res.status(200).json({ ok: true });
  }

  const name = clean(body.name, LIMITS.name);
  const email = clean(body.email, LIMITS.email);
  const message = clean(body.message, LIMITS.message);
  // Strictly `=== true`. A missing field, "false", "off", 0 or anything else
  // a stray client might send is a no, because the only thing that may turn
  // this on is somebody ticking the box.
  const subscribe = body.subscribe === true;

  const errors = {};
  if (!name) errors.name = "Please tell me your name.";
  if (!email) errors.email = "Please add an email address so I can reply.";
  else if (!looksLikeEmail(email)) errors.email = "That email address does not look right.";
  if (!message) errors.message = "Please describe what is happening.";
  else if (message.length < MIN_MESSAGE) errors.message = "A sentence or two would help.";

  if (Object.keys(errors).length) {
    return res.status(400).json({ ok: false, errors });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: "That is a few messages in a row. Try again in a minute." });
  }

  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    // Loud in the log, vague to the visitor -- configuration problems are
    // not the visitor's business, and they must never lose the message
    // without being told to use the email address instead.
    console.error("[contact] RESEND_API_KEY or EMAIL_FROM is not configured.");
    return res.status(503).json({
      ok: false,
      error: "The form is not available right now. Please email " + TO + " directly.",
    });
  }

  // Done before the notification so its outcome can go in the email. A
  // silent failure here would otherwise look exactly like a silent success.
  const listOutcome = subscribe ? await addToMarketingList(email, key) : "not_requested";

  const text =
    "New enquiry from tobi.getpolisha.com\n\n" +
    "Name:  " + name + "\n" +
    "Email: " + email + "\n" +
    "List:  " + listOutcome + "\n\n" +
    message + "\n";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from,
        to: [TO],
        reply_to: email,          // replying in the inbox reaches the sender
        subject: "Website enquiry — " + name,
        text: text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[contact] Resend refused the message:", response.status, detail);
      return res.status(502).json({
        ok: false,
        error: "The message could not be sent. Please email " + TO + " directly.",
      });
    }
  } catch (error) {
    console.error("[contact] Could not reach Resend:", error && error.message);
    return res.status(502).json({
      ok: false,
      error: "The message could not be sent. Please email " + TO + " directly.",
    });
  }

  return res.status(200).json({ ok: true });
};
